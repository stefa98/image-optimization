// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

function handler(event) {
    var request = event.request;
    var originalImagePath = request.uri;

    // Inizializza le operazioni normalizzate
    var normalizedOperations = {};

    // Gestisci il formato basato sull'header Accept
    var format = 'jpeg';
    if (request.headers['accept']) {
        if (request.headers['accept'].value.includes("avif")) {
            format = 'avif';
        } else if (request.headers['accept'].value.includes("webp")) {
            format = 'webp';
        }
    }
    normalizedOperations['format'] = format;

    // Gestisci i parametri della query string
    if (request.querystring) {
        Object.keys(request.querystring).forEach(operation => {
            switch (operation.toLowerCase()) {
                case 'width':
                    if (request.querystring[operation] && request.querystring[operation].value) {
                        var width = parseInt(request.querystring[operation].value);
                        if (!isNaN(width) && width > 0) {
                            // Limita la larghezza massima a 3840px
                            width = Math.min(width, 3840);
                            normalizedOperations['width'] = width.toString();
                        }
                    }
                    break;
                default:
                    break;
            }
        });
    }

    // Costruisci il nuovo path
    if (Object.keys(normalizedOperations).length > 0) {
        var normalizedOperationsArray = [];
        if (normalizedOperations.format) normalizedOperationsArray.push('format=' + normalizedOperations.format);
        if (normalizedOperations.width) normalizedOperationsArray.push('width=' + normalizedOperations.width);
        request.uri = originalImagePath + '/' + normalizedOperationsArray.join(',');
    } else {
        request.uri = originalImagePath + '/original';
    }

    // Rimuovi le query string originali
    request.querystring = {};

    return request;
}
