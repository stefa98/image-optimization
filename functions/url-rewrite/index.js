// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

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

    // Se c'è una richiesta di width=1200, usa la versione pre-generata
    if (request.querystring && request.querystring['width'] &&
        request.querystring['width'].value === '1200') {
        request.uri = originalImagePath + '/format=' + format + ',width=1200';
        request['querystring'] = {};
        return request;
    }

    // Se non ci sono query parameters, usa la versione originale ottimizzata
    if (!request.querystring || Object.keys(request.querystring).length === 0) {
        // Usa la versione originale pre-ottimizzata nel formato migliore
        request.uri = originalImagePath + '/format=' + format + ',width=' + 'original';
        request['querystring'] = {};
        return request;
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
