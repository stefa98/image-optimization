// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

function handler(event) {
    var request = event.request;
    var originalImagePath = request.uri;
    //  validate, process and normalize the requested operations in query parameters
    var normalizedOperations = {};
    var format = 'jpeg'; // Corretto: aggiunta dichiarazione con var
    if (request.headers['accept']) {
        if (request.headers['accept'].value.includes("avif")) {
            format = 'avif';
        } else if (request.headers['accept'].value.includes("webp")) {
            format = 'webp';
        }
    }
    normalizedOperations['format'] = format;
    if (request.querystring) {
        Object.keys(request.querystring).forEach(operation => {
            switch (operation.toLowerCase()) {
                case 'width':
                    if (request.querystring[operation]['value']) {
                        var width = parseInt(request.querystring[operation]['value']);
                        if (!isNaN(width) && (width > 0)) {
                            // Limita la larghezza massima a 4000 pixel (4K)
                            if (width > 4000) width = 4000;
                            normalizedOperations['width'] = width.toString();
                        }
                    }
                    break;
                default: break;
            }
        });
        //rewrite the path to normalized version if valid operations are found
        if (Object.keys(normalizedOperations).length > 0) {
            // put them in order
            var normalizedOperationsArray = [];
            if (normalizedOperations.format) normalizedOperationsArray.push('format=' + normalizedOperations.format);
            if (normalizedOperations.width) normalizedOperationsArray.push('width=' + normalizedOperations.width);
            request.uri = originalImagePath + '/' + normalizedOperationsArray.join(',');
        } else {
            // If no valid operation is found, flag the request with /original path suffix
            request.uri = originalImagePath + '/original';
        }

    } else {
        // If no query strings are found, flag the request with /original path suffix
        request.uri = originalImagePath + '/original';
    }
    // remove query strings
    request['querystring'] = {};
    return request;
}
