import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import Sharp from 'sharp';

const s3Client = new S3Client();
const S3_ORIGINAL_IMAGE_BUCKET = process.env.originalImageBucketName;
const S3_TRANSFORMED_IMAGE_BUCKET = process.env.transformedImageBucketName;
const TRANSFORMED_IMAGE_CACHE_TTL = process.env.transformedImageCacheTTL;
const MAX_IMAGE_SIZE = parseInt(process.env.maxImageSize);
const DEFAULT_WIDTH = 1200;

const COMMON_WIDTHS = [1080, 1200];

export const handler = async (event) => {
    if (event.Records && event.Records[0].eventSource === 'aws:s3') {
        return await handleS3Upload(event);
    }

    if (!event.requestContext || !event.requestContext.http || !(event.requestContext.http.method === 'GET')) return sendError(400, 'Only GET method is supported', event);

    var imagePathArray = event.requestContext.http.path.split('/');
    var operationsPrefix = imagePathArray.pop();
    imagePathArray.shift();
    var originalImagePath = imagePathArray.join('/');

    var startTime = performance.now();
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
    const imageMetadata = await transformedImage.metadata();
    const operationsJSON = Object.fromEntries(operationsPrefix.split(',').map(operation => operation.split('=')));
    var timingLog = 'img-download;dur=' + parseInt(performance.now() - startTime);
    startTime = performance.now();
    try {
        const resizingOptions = {
            fit: 'inside',
            fastShrinkOnLoad: true,
            withoutEnlargement: true
        };

        if (operationsJSON['width']) {
            resizingOptions.width = parseInt(operationsJSON['width']);
        }

        transformedImage = transformedImage
            .resize(resizingOptions)
            .rotate();

        transformedImage = transformedImage.withMetadata({
            orientation: undefined,
            density: 72,
        });

        const formatOptions = {
            webp: {
                quality: 80,
                effort: 6,
                smartSubsample: true,
                nearLossless: false,
                reductionEffort: 6,
                mixed: true
            },
            avif: {
                quality: 75,
                effort: 8,
                chromaSubsampling: '4:4:4',
                speed: 0,
                lossless: false
            },
            jpeg: {
                quality: 82,
                progressive: true,
                trellisQuantisation: true,
                overshootDeringing: true,
                optimizeScans: true,
                mozjpeg: true,
                chromaSubsampling: '4:4:4'
            }
        };

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
            if (contentType === 'image/svg+xml') contentType = 'image/png';
        }

        transformedImage = transformedImage.withMetadata({
            icc: false,
            exif: false,
            xmp: false
        });

        transformedImage = await transformedImage.toBuffer();
    } catch (error) {
        return sendError(500, 'error transforming image', error);
    }

    timingLog = timingLog + ',img-transform;dur=' + parseInt(performance.now() - startTime);

    const imageTooBig = Buffer.byteLength(transformedImage) > MAX_IMAGE_SIZE;

    if (S3_TRANSFORMED_IMAGE_BUCKET) {
        startTime = performance.now();
        try {
            const putImageCommand = new PutObjectCommand({
                Body: transformedImage,
                Bucket: S3_TRANSFORMED_IMAGE_BUCKET,
                Key: originalImagePath + '/' + operationsPrefix,
                ContentType: contentType,
                CacheControl: TRANSFORMED_IMAGE_CACHE_TTL,
                Metadata: {
                    'optimization-type': 'sharp',
                    'original-width': imageMetadata.width.toString(),
                    'image-quality': (formatOptions[operationsJSON['format']]?.quality || 82).toString()
                }
            });
            await s3Client.send(putImageCommand);
            timingLog = timingLog + ',img-upload;dur=' + parseInt(performance.now() - startTime);
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

    if (imageTooBig) {
        return sendError(403, 'Requested transformed image is too big', '');
    } else return {
        statusCode: 200,
        body: transformedImage.toString('base64'),
        isBase64Encoded: true,
        headers: {
            'Content-Type': contentType,
            'Cache-Control': TRANSFORMED_IMAGE_CACHE_TTL,
            'Server-Timing': timingLog
        }
    };
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
            processAndUploadVariant(originalImageBody, key, 'jpeg'),

            ...COMMON_WIDTHS.flatMap(width => [
                processAndUploadVariant(originalImageBody, key, 'webp', width),
                processAndUploadVariant(originalImageBody, key, 'avif', width),
                processAndUploadVariant(originalImageBody, key, 'jpeg', width)
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

        transformedImage = transformedImage.withMetadata({
            orientation: undefined,
            density: 72,
        });

        const formatOptions = {
            webp: {
                quality: 80,
                effort: 6,
                smartSubsample: true,
                nearLossless: false,
                reductionEffort: 6,
                mixed: true
            },
            avif: {
                quality: 75,
                effort: 8,
                chromaSubsampling: '4:4:4',
                speed: 0,
                lossless: false
            },
            jpeg: {
                quality: 82,
                progressive: true,
                trellisQuantisation: true,
                overshootDeringing: true,
                optimizeScans: true,
                mozjpeg: true,
                chromaSubsampling: '4:4:4'
            }
        };

        transformedImage = transformedImage.toFormat(format, formatOptions[format] || {
            quality: 82,
            progressive: true
        });

        transformedImage = transformedImage.withMetadata({
            icc: false,
            exif: false,
            xmp: false
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
            Metadata: {
                'optimization-type': 'sharp',
                'original-width': width.toString(),
                'image-quality': formatOptions[format].quality.toString()
            }
        });

        await s3Client.send(putCommand);
        console.log(`Uploaded optimized version: ${optimizedKey}`);
    } catch (error) {
        console.error(`Error processing variant ${format} for ${originalKey}:`, error);
        throw error;
    }
}
