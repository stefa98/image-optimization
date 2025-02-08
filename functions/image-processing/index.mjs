// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import Sharp from 'sharp';

const s3Client = new S3Client();
const S3_ORIGINAL_IMAGE_BUCKET = process.env.originalImageBucketName;
const S3_TRANSFORMED_IMAGE_BUCKET = process.env.transformedImageBucketName;
const TRANSFORMED_IMAGE_CACHE_TTL = process.env.transformedImageCacheTTL;
const MAX_IMAGE_SIZE = parseInt(process.env.maxImageSize);
const DEFAULT_WIDTH = 1200;

const COMMON_WIDTHS = [640, 750, 828, 1080, 1200, 1920];

const formatOptions = {
    webp: {
        quality: 80,
        effort: 6,
        smartSubsample: true,
        nearLossless: false,
        mixed: true,
        reductionEffort: 6
    },
    avif: {
        quality: 75,
        effort: 8,
        chromaSubsampling: '4:2:0',
        lossless: false,
        speed: 0
    },
    jpeg: {
        quality: 80,
        progressive: true,
        trellisQuantisation: true,
        overshootDeringing: true,
        optimizeScans: true,
        mozjpeg: true,
        chromaSubsampling: '4:2:0',
        quantisationTable: 3
    }
};

export const handler = async (event) => {
    if (event.Records && event.Records[0].eventSource === 'aws:s3') {
        return await handleS3Upload(event);
    }
    // Validate if this is a GET request
    if (!event.requestContext || !event.requestContext.http || !(event.requestContext.http.method === 'GET')) return sendError(400, 'Only GET method is supported', event);
    // An example of expected path is /images/rio/1.jpeg/format=auto,width=100 or /images/rio/1.jpeg/original where /images/rio/1.jpeg is the path of the original image
    var imagePathArray = event.requestContext.http.path.split('/');
    // get the requested image operations
    var operationsPrefix = imagePathArray.pop();
    // get the original image path images/rio/1.jpg
    imagePathArray.shift();
    var originalImagePath = imagePathArray.join('/');

    var startTime = performance.now();
    // Downloading original image
    let originalImageBody;
    let contentType;
    try {
        const getOriginalImageCommand = new GetObjectCommand({ Bucket: S3_ORIGINAL_IMAGE_BUCKET, Key: originalImagePath });
        const getOriginalImageCommandOutput = await s3Client.send(getOriginalImageCommand);

        originalImageBody = getOriginalImageCommandOutput.Body.transformToByteArray();
        contentType = getOriginalImageCommandOutput.ContentType;
    } catch (error) {
        return sendError(500, 'Error downloading original image', error);
    }
    let transformedImage = Sharp(await originalImageBody, { failOn: 'none', animated: true });
    // Get image orientation to rotate if needed
    const imageMetadata = await transformedImage.metadata();
    // execute the requested operations
    const operationsJSON = Object.fromEntries(operationsPrefix.split(',').map(operation => operation.split('=')));
    // variable holding the server timing header value
    var timingLog = 'img-download;dur=' + parseInt(performance.now() - startTime);
    startTime = performance.now();
    try {
        // check if resizing is requested
        const resizingOptions = {
            fit: 'inside',
            fastShrinkOnLoad: true,
            withoutEnlargement: true
        };
        if (operationsJSON['width']) resizingOptions.width = parseInt(operationsJSON['width']);
        if (resizingOptions) transformedImage = transformedImage.resize(resizingOptions);

        // check if rotation is needed
        if (imageMetadata.orientation) transformedImage = transformedImage.rotate();

        // check if formatting is requested
        if (operationsJSON['format']) {
            switch (operationsJSON['format']) {
                case 'jpeg': contentType = 'image/jpeg'; break;
                case 'webp': contentType = 'image/webp'; break;
                case 'avif': contentType = 'image/avif'; break;
                default: contentType = 'image/jpeg';
            }
            transformedImage = transformedImage.toFormat(operationsJSON['format'],
                formatOptions[operationsJSON['format']] || {
                    quality: 82,
                    progressive: true
                }
            );
        } else {
            /// If not format is precised, Sharp converts svg to png by default https://github.com/aws-samples/image-optimization/issues/48
            if (contentType === 'image/svg+xml') contentType = 'image/png';
        }

        transformedImage = await transformedImage.toBuffer();
    } catch (error) {
        return sendError(500, 'error transforming image', error);
    }
    timingLog = timingLog + ',img-transform;dur=' + parseInt(performance.now() - startTime);

    // handle gracefully generated images bigger than a specified limit (e.g. Lambda output object limit)
    const imageTooBig = Buffer.byteLength(transformedImage) > MAX_IMAGE_SIZE;

    // upload transformed image back to S3 if required in the architecture
    if (S3_TRANSFORMED_IMAGE_BUCKET) {
        startTime = performance.now();
        try {
            const putImageCommand = new PutObjectCommand({
                Body: transformedImage,
                Bucket: S3_TRANSFORMED_IMAGE_BUCKET,
                Key: originalImagePath + '/' + operationsPrefix,
                ContentType: contentType,
                CacheControl: TRANSFORMED_IMAGE_CACHE_TTL,
            })
            await s3Client.send(putImageCommand);
            timingLog = timingLog + ',img-upload;dur=' + parseInt(performance.now() - startTime);
            // If the generated image file is too big, send a redirection to the generated image on S3, instead of serving it synchronously from Lambda.
            if (imageTooBig) {
                return {
                    statusCode: 302,
                    headers: {
                        'Location': '/' + originalImagePath + '?' + operationsPrefix.replace(/,/g, "&"),
                        'Cache-Control': 'private,no-store',
                        'Server-Timing': timingLog
                    }
                };
            }
        } catch (error) {
            logError('Could not upload transformed image to S3', error);
        }
    }

    // Return error if the image is too big and a redirection to the generated image was not possible, else return transformed image
    if (imageTooBig) {
        return sendError(403, 'Requested transformed image is too big', '');
    } else {
        const result = {
            statusCode: 200,
            body: transformedImage.toString('base64'),
            isBase64Encoded: true,
            headers: {
                'Content-Type': contentType,
                'Cache-Control': TRANSFORMED_IMAGE_CACHE_TTL,
                'Server-Timing': timingLog
            }
        };
        return result;
    }
};

function sendError(statusCode, body, error) {
    logError(body, error);
    return { statusCode, body };
}

function logError(body, error) {
    console.log('APPLICATION ERROR', body);
    console.log(error);
}

async function handleS3Upload(event) {
    const bucket = event.Records[0].s3.bucket.name;
    const key = decodeURIComponent(event.Records[0].s3.object.key);

    try {
        const getOriginalImageCommand = new GetObjectCommand({
            Bucket: bucket,
            Key: key
        });
        const originalImage = await s3Client.send(getOriginalImageCommand);
        const originalImageBody = await originalImage.Body.transformToByteArray();
        const contentType = originalImage.ContentType;

        // Skip processing if not an image
        if (!contentType.startsWith('image/')) {
            return {
                statusCode: 200,
                body: 'Skipped non-image file'
            };
        }

        // Check file size (1MB = 1048576 bytes)
        const isLargeImage = originalImage.ContentLength > 1048576;

        // For large images, only process WebP
        const optimizationTasks = [];

        if (isLargeImage) {
            optimizationTasks.push(
                processAndUploadVariant(originalImageBody, key, 'webp'),
                ...COMMON_WIDTHS.map(width =>
                    processAndUploadVariant(originalImageBody, key, 'webp', width)
                )
            );
        } else {
            // For smaller images, process both WebP and AVIF
            optimizationTasks.push(
                processAndUploadVariant(originalImageBody, key, 'webp'),
                processAndUploadVariant(originalImageBody, key, 'avif'),
                ...COMMON_WIDTHS.flatMap(width => [
                    processAndUploadVariant(originalImageBody, key, 'webp', width),
                    processAndUploadVariant(originalImageBody, key, 'avif', width)
                ])
            );
        }

        // Use Promise.allSettled instead of Promise.all to continue even if some variants fail
        const results = await Promise.allSettled(optimizationTasks);

        // Log any failures
        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                console.error(`Task ${index} failed:`, result.reason);
            }
        });

        return {
            statusCode: 200,
            body: 'Image optimization completed'
        };
    } catch (error) {
        return sendError(500, 'Error processing new image upload', error);
    }
}

// Modify optimizeByDimensions to adjust quality based on image size
async function optimizeByDimensions(image, format, width) {
    const metadata = await image.metadata();
    let quality = 80;

    // Reduce quality for large images
    const fileSize = metadata.size || 0;
    if (fileSize > 1048576) { // larger than 1MB
        quality = 65;
    } else if (width && width < 800) {
        quality = 75;
    } else if (metadata.width > 2000) {
        quality = 70;
    }

    const options = { ...formatOptions[format] };
    options.quality = quality;

    // For large WebP images, optimize for size
    if (format === 'webp' && fileSize > 1048576) {
        options.effort = 6;
        options.quality = 65;
        options.smartSubsample = true;
    }

    return options;
}

async function processAndUploadVariant(originalImageBody, originalKey, format, width = null) {
    try {
        // Initialize Sharp with better error handling
        let transformedImage = Sharp(originalImageBody, {
            failOn: 'none',
            animated: true,
            limitInputPixels: false // Allow processing of larger images
        });

        // Get initial metadata to verify image is valid
        const metadata = await transformedImage.metadata();
        if (!metadata) {
            console.warn(`Skipping ${format} variant for ${originalKey}: Invalid image metadata`);
            return; // Skip this variant instead of throwing error
        }

        if (width) {
            transformedImage = transformedImage.resize({
                width,
                withoutEnlargement: true,
                fit: 'inside',
                fastShrinkOnLoad: true
            });
        }

        // Handle rotation based on EXIF data
        if (metadata.orientation) {
            transformedImage = transformedImage.rotate();
        }

        // For PNG images specifically, convert to JPEG before AVIF conversion
        if (format === 'avif' && metadata.format === 'png') {
            transformedImage = transformedImage.toFormat('jpeg', { quality: 100 });
        }

        const optimizedOptions = await optimizeByDimensions(transformedImage, format, width);
        transformedImage = transformedImage.toFormat(format, optimizedOptions);

        const buffer = await transformedImage.toBuffer();

        // Skip upload if buffer is empty
        if (!buffer || buffer.length === 0) {
            console.warn(`Skipping ${format} variant for ${originalKey}: Empty buffer generated`);
            return;
        }

        const optimizedKey = width
            ? `${originalKey}/format=${format},width=${width}`
            : `${originalKey}/format=${format}`;

        const putCommand = new PutObjectCommand({
            Bucket: S3_TRANSFORMED_IMAGE_BUCKET,
            Key: optimizedKey,
            Body: buffer,
            ContentType: `image/${format}`,
            CacheControl: TRANSFORMED_IMAGE_CACHE_TTL,
        });

        await s3Client.send(putCommand);
    } catch (error) {
        // Log error but don't throw, allowing other variants to continue
        console.error(`Error processing variant ${format} for ${originalKey}:`, error);
        // Only throw if this is a critical error that should stop all processing
        if (error.message.includes('memory') || error.message.includes('allocation')) {
            throw error;
        }
    }
}
