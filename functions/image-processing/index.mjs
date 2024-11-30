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

export const handler = async (event) => {
    // Verifica se l'evento proviene da S3 (nuovo caricamento)
    if (event.Records && event.Records[0].eventSource === 'aws:s3') {
        // Gestione del caricamento iniziale in S3
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
        // Applica le trasformazioni di base
        const resizingOptions = {
            fit: 'inside',        // Mantiene le proporzioni
            fastShrinkOnLoad: true, // Ottimizzazione performance
            withoutEnlargement: true // Evita l'ingrandimento
        };

        if (operationsJSON['width']) {
            resizingOptions.width = parseInt(operationsJSON['width']);
        }

        transformedImage = transformedImage
            .resize(resizingOptions)
            .rotate(); // Gestisce automaticamente l'orientamento

        // Ottimizzazione metadata per SEO
        transformedImage = transformedImage.withMetadata({
            orientation: undefined,  // Rimuove l'orientamento dopo la rotazione
            density: 72,            // DPI standard per web
        });

        // Imposta il formato con le opzioni di ottimizzazione appropriate
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
            if (contentType === 'image/svg+xml') contentType = 'image/png';
        }

        // Ottimizzazione aggiuntiva per rimuovere metadata non necessari
        transformedImage = transformedImage.withMetadata({
            icc: false,      // Rimuove profilo colore
            exif: false,     // Rimuove dati EXIF
            xmp: false       // Rimuove metadati XMP
        });

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
                // Aggiungi metadata per CDN e cache
                Metadata: {
                    'optimization-type': 'sharp',
                    'original-width': imageMetadata.width.toString(),
                    'image-quality': (formatOptions[operationsJSON['format']]?.quality || 82).toString()
                }
            });
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
        // Scarica l'immagine originale
        const getOriginalImageCommand = new GetObjectCommand({
            Bucket: bucket,
            Key: key
        });
        const originalImage = await s3Client.send(getOriginalImageCommand);
        const originalImageBody = await originalImage.Body.transformToByteArray();
        const contentType = originalImage.ContentType;

        // Ottieni le dimensioni originali dell'immagine
        const metadata = await Sharp(originalImageBody).metadata();

        // Array di task per l'ottimizzazione
        const optimizationTasks = [
            // Versioni a dimensione originale ottimizzate
            processAndUploadVariant(originalImageBody, key, 'webp', metadata.width),
            processAndUploadVariant(originalImageBody, key, 'avif', metadata.width),
            processAndUploadVariant(originalImageBody, key, 'jpeg', metadata.width),

            // Versioni a 1200px
            processAndUploadVariant(originalImageBody, key, 'webp', DEFAULT_WIDTH),
            processAndUploadVariant(originalImageBody, key, 'avif', DEFAULT_WIDTH),
            processAndUploadVariant(originalImageBody, key, 'jpeg', DEFAULT_WIDTH)
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

async function processAndUploadVariant(originalImageBody, originalKey, format, width) {
    try {
        let transformedImage = Sharp(originalImageBody, {
            failOn: 'none',
            animated: true
        });

        // Applica le trasformazioni
        transformedImage = transformedImage
            .resize({
                width,
                withoutEnlargement: true,
                fit: 'inside',        // Mantiene le proporzioni
                fastShrinkOnLoad: true // Ottimizzazione performance
            })
            .rotate(); // Gestisce automaticamente l'orientamento

        // Ottimizzazione metadata per SEO
        transformedImage = transformedImage.withMetadata({
            orientation: undefined,  // Rimuove l'orientamento dopo la rotazione
            density: 72,            // DPI standard per web
        });

        // Imposta il formato con le opzioni di ottimizzazione appropriate
        const formatOptions = {
            webp: {
                quality: 80,           // Buon equilibrio qualità/dimensione
                effort: 6,            // Maggiore compressione (range 0-6)
                smartSubsample: true, // Migliore qualità per aree colorate
                nearLossless: false,  // Mantiene dimensioni file ragionevoli
                reductionEffort: 6,   // Massimo sforzo di riduzione
                mixed: true           // Ottimizza per immagini con testo
            },
            avif: {
                quality: 75,          // AVIF può mantenere alta qualità con valori più bassi
                effort: 8,           // Maggiore compressione (range 0-9)
                chromaSubsampling: '4:4:4', // Massima qualità colore
                speed: 0,            // Massima compressione
                lossless: false      // Mantiene dimensioni file ragionevoli
            },
            jpeg: {
                quality: 82,         // Ottimo per web
                progressive: true,   // Caricamento progressivo
                trellisQuantisation: true, // Migliore compressione
                overshootDeringing: true,  // Migliore qualità bordi
                optimizeScans: true,       // Ottimizzazione progressive
                mozjpeg: true,             // Usa mozjpeg per migliore compressione
                chromaSubsampling: '4:4:4' // Massima qualità colore
            }
        };

        // Applica ottimizzazioni specifiche per formato
        transformedImage = transformedImage.toFormat(format, formatOptions[format] || {
            quality: 82,
            progressive: true
        });

        // Ottimizzazione aggiuntiva per rimuovere metadata non necessari
        transformedImage = transformedImage.withMetadata({
            icc: false,      // Rimuove profilo colore
            exif: false,     // Rimuove dati EXIF
            xmp: false       // Rimuove metadati XMP
        });

        const buffer = await transformedImage.toBuffer();

        // Costruisci il path per la versione ottimizzata
        const optimizedKey = `${originalKey}/format=${format},width=${width}`;

        // Carica la versione ottimizzata
        const putCommand = new PutObjectCommand({
            Bucket: S3_TRANSFORMED_IMAGE_BUCKET,
            Key: optimizedKey,
            Body: buffer,
            ContentType: `image/${format}`,
            CacheControl: TRANSFORMED_IMAGE_CACHE_TTL,
            // Aggiungi metadata per CDN e cache
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
