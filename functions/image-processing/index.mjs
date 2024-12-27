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
        quality: 85,
        effort: 4,
        smartSubsample: true,
        nearLossless: false,
        mixed: true
    },
    avif: {
        quality: 80,
        effort: 6,
        chromaSubsampling: '4:2:0',
        lossless: false
    },
    jpeg: {
        quality: 85,
        progressive: true,
        trellisQuantisation: true,
        overshootDeringing: true,
        optimizeScans: true,
        mozjpeg: true,
        chromaSubsampling: '4:2:0'
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
        console.log(`Got response from S3 for ${originalImagePath}`);

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

        const metadata = await Sharp(originalImageBody).metadata();

        const optimizationTasks = [
            processAndUploadVariant(originalImageBody, key, 'webp'),
            processAndUploadVariant(originalImageBody, key, 'avif'),

            ...COMMON_WIDTHS.flatMap(width => [
                processAndUploadVariant(originalImageBody, key, 'webp', width),
                processAndUploadVariant(originalImageBody, key, 'avif', width)
            ])
        ];

        await Promise.all(optimizationTasks);

        console.log(`Successfully pre-generated optimized versions for ${key}`);
        return {
            statusCode: 200,
            body: 'Image optimization completed'
        };
    } catch (error) {
        return sendError(500, 'Error processing new image upload', error);
    }
}

async function processAndUploadVariant(originalImageBody, originalKey, format, width = null) {
    try {
        let transformedImage = Sharp(originalImageBody, {
            failOn: 'none',
            animated: true
        });

        if (width) {
            transformedImage = transformedImage.resize({
                width,
                withoutEnlargement: true,
                fit: 'inside',
                fastShrinkOnLoad: true
            });
        }

        transformedImage = transformedImage.rotate();

        transformedImage = transformedImage.toFormat(format, formatOptions[format] || {
            quality: 82,
            progressive: true
        });

        const buffer = await transformedImage.toBuffer();

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
        console.log(`Uploaded optimized version: ${optimizedKey}`);
    } catch (error) {
        console.error(`Error processing variant ${format} for ${originalKey}:`, error);
        throw error;
    }
}
