// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Aggiungi le dimensioni comuni
const COMMON_WIDTHS = [300, 600, 800, 1200];

function handler(event) {
    var request = event.request;
    var originalImagePath = request.uri;
    var format = 'jpeg';

    // Determina il miglior formato basato sull'Accept header
    if (request.headers['accept']) {
        if (request.headers['accept'].value.includes("avif")) {
            format = 'avif';
        } else if (request.headers['accept'].value.includes("webp")) {
            format = 'webp';
        }
    }

    // Se non ci sono query parameters, usa la versione originale ottimizzata
    if (!request.querystring || Object.keys(request.querystring).length === 0) {
        request.uri = originalImagePath + '/format=' + format;
        request['querystring'] = {};
        return request;
    }

    // Verifica se la width richiesta è tra quelle pre-generate
    if (request.querystring && request.querystring['width']) {
        const requestedWidth = parseInt(request.querystring['width'].value);
        if (COMMON_WIDTHS.includes(requestedWidth)) {
            // Usa la versione pre-generata
            request.uri = originalImagePath + '/format=' + format + ',width=' + requestedWidth;
            request['querystring'] = {};
            return request;
        }
    }

    // Per tutte le altre dimensioni richieste, procedi con l'ottimizzazione on-demand
    var normalizedOperations = {};
    normalizedOperations['format'] = format;

    Object.keys(request.querystring).forEach(operation => {
        switch (operation.toLowerCase()) {
            case 'width':
                if (request.querystring[operation]['value']) {
                    var width = parseInt(request.querystring[operation]['value']);
                    if (!isNaN(width) && (width > 0)) {
                        if (width > 4000) width = 4000;
                        normalizedOperations['width'] = width.toString();
                    }
                }
                break;
            default: break;
        }
    });

    if (Object.keys(normalizedOperations).length > 0) {
        var normalizedOperationsArray = [];
        if (normalizedOperations.format) normalizedOperationsArray.push('format=' + normalizedOperations.format);
        if (normalizedOperations.width) normalizedOperationsArray.push('width=' + normalizedOperations.width);
        request.uri = originalImagePath + '/' + normalizedOperationsArray.join(',');
    }

    request['querystring'] = {};
    return request;
}
