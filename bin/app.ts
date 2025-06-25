#!/usr/bin/env node
import 'source-map-support/register';
import cdk = require("aws-cdk-lib")
import { ApplicationStack } from '../deployment/application/application-stack'
import { VpcStack } from "../deployment/vpc/vpc-stack"

const app = new cdk.App();
new VpcStack(app, 'VpcStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION
  }
});

const ctxVpcId = app.node.tryGetContext('vpc_id');
const ctxFloatingIp = app.node.tryGetContext('floating_ip');
const ctxClientSubnetIds = app.node.tryGetContext('client_subnet_ids');
const ctxTargetEniPrimary = app.node.tryGetContext('target_eni_primary');
const ctxTargetEniSecondary = app.node.tryGetContext('target_eni_secondary');
const ctxProbingTimeout = app.node.tryGetContext('probing_timeout');
const ctxProbingProtocol = app.node.tryGetContext('probing_protocol');
const ctxProbingFailedThreshold = app.node.tryGetContext('probing_failed_threshold');
const ctxProbingInterval = app.node.tryGetContext('probing_interval');
const ctxProbingPort = app.node.tryGetContext('probing_port') ?? 22;

new ApplicationStack(app, 'ApplicationStack', {
  ctxVpcId,
  ctxFloatingIp,
  ctxClientSubnetIds,
  ctxTargetEniPrimary,
  ctxTargetEniSecondary,
  ctxProbingTimeout,
  ctxProbingProtocol,
  ctxProbingFailedThreshold,
  ctxProbingInterval: ctxProbingInterval,
  ctxProbingPort,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION
  },
  description: 'Guidance for using floating virtual ip address on aws (SO9040)'
});