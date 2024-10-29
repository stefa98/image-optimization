#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import 'source-map-support/register';
import { ImageOptimizationStack } from '../lib/image-optimization-stack';


const app = new cdk.App();
const context = app.node.tryGetContext('stackName') || 'ImgTransformationStack';
new ImageOptimizationStack(app, context, {

});

