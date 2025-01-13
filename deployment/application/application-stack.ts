import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdanodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from 'constructs';

import * as cr from 'aws-cdk-lib/custom-resources';

import { StepFunctionConstruct } from './step-function'

interface ApplicationStackProps extends cdk.StackProps {
    ctxVpcId: string;
    ctxFloatingIp: string;
    ctxClientSubnetIds: string;
    ctxTargetEniPrimary: string;
    ctxTargetEniSecondary: string;
    ctxProbingTimeout: string;
    ctxProbingProtocol: string;
    ctxProbingFailedThreshold: number;
    ctxProbingInterval: number
    ctxProbingPort: number
}

export class ApplicationStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: ApplicationStackProps) {
        super(scope, id, props);
        const clientSubnetIds = props.ctxClientSubnetIds.split(',');
        const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { isDefault: false, vpcId: props.ctxVpcId });


        const clientSubnets: ec2.ISubnet[] = [];
        clientSubnetIds.forEach(sub => {
            clientSubnets.push(ec2.Subnet.fromSubnetId(this, 'Subnet-' + sub, sub));
        });

        const getRouteTableId = new cr.AwsCustomResource(this, 'GetRouteTableId', {
            onUpdate: {
                service: 'EC2',
                action: 'describeRouteTables',
                parameters: {
                    Filters: [
                        {
                            Name: 'association.subnet-id',
                            Values: clientSubnetIds
                        },
                    ],
                },
                physicalResourceId: cr.PhysicalResourceId.of(Date.now().toString())
            },
            policy: cr.AwsCustomResourcePolicy.fromStatements([
                new iam.PolicyStatement({
                    actions: ['ec2:DescribeRouteTables'],
                    resources: ['*'],
                    effect: iam.Effect.ALLOW
                })
            ])
        });

        const clientRTIds: string[] = [];
        clientSubnetIds.forEach((subnetId, index) => {
            const clientRTId = getRouteTableId.getResponseField(`RouteTables.${index}.RouteTableId`);
            clientRTIds.push(clientRTId);

            new ec2.CfnRoute(this, `StaticRouteFloatingIp-${subnetId}`, {
                destinationCidrBlock: props.ctxFloatingIp + '/32',
                routeTableId: clientRTId,
                networkInterfaceId: props.ctxTargetEniPrimary,
            });
        });

        const probingLambdaSG = new ec2.SecurityGroup(this, 'ProbingLambdaSG', {
            vpc: vpc,
            allowAllOutbound: true,
            description: 'Security Group for Probing Lambda',
        });

        const probingLambdaRole = new iam.Role(this, 'ProbingLambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')
            ]
        });
        probingLambdaRole.addToPolicy(new iam.PolicyStatement({
            actions: ['cloudwatch:PutMetricData'],
            resources: ['*']
        }));

        const probingLambdaLogGroup = new logs.LogGroup(this, 'ProbingLambdaLogGroup', {
            logGroupName: `/aws/lambda/ProbingLambda`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        const probingLambda = new lambdanodejs.NodejsFunction(this, 'ProbingLambda', {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'index.handler',
            code: new lambda.AssetCode('./dest/source/lambda/probing'),
            vpc: vpc,
            vpcSubnets: {
                subnets: clientSubnets
            },
            securityGroups: [probingLambdaSG],
            environment: {
                'FLOATING_IP': props.ctxFloatingIp,
                'PROBING_PORT': String(props.ctxProbingPort),
                'PROBING_PROTOCOL': props.ctxProbingProtocol,
                'PROBING_TIMEOUT': props.ctxProbingTimeout
            },
            logGroup: probingLambdaLogGroup,
            role: probingLambdaRole
        });
        //probingLambdaLogGroup.grantWrite(probingLambda);


        const failoverLambdaRole = new iam.Role(this, 'FailoverLambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
            ]
        });
        failoverLambdaRole.addToPolicy(new iam.PolicyStatement({
            actions: ['ec2:DescribeRouteTables'],
            resources: ['*']
        }));
        failoverLambdaRole.addToPolicy(new iam.PolicyStatement({
            actions: ['cloudwatch:PutMetricData'],
            resources: ['*'],
        }));
        failoverLambdaRole.addToPolicy(new iam.PolicyStatement({
            actions: ['ec2:ReplaceRoute'],
            resources: clientRTIds.map(rt => `arn:aws:ec2:${this.region}:${this.account}:route-table/${rt}`),
        }));

        const failoverLambda = new lambda.Function(this, 'FailoverLambda', {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'index.handler',
            code: new lambda.AssetCode('./dest/source/lambda/failover'),
            timeout: cdk.Duration.seconds(10),
            environment: {
                'ROUTE_TABLES': clientRTIds.toString(),
                'FLOATING_IP': props.ctxFloatingIp + '/32',
                'ENI_PRIMARY': props.ctxTargetEniPrimary,
                'ENI_SECONDARY': props.ctxTargetEniSecondary
            },
            role: failoverLambdaRole
        });

        const table = new dynamodb.Table(this, 'DynamoDBContext', {
            partitionKey: { name: 'attrName', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            tableName: 'DynamoDBContext'
        });

        const stepFunctionConstruct = new StepFunctionConstruct(this, 'StepFunctionConstruct', {
            lambdaProbing: probingLambda,
            lambdaFailover: failoverLambda,
            contextTable: table,
            probingFailedThreshold: props.ctxProbingFailedThreshold,
            probingInterval: props.ctxProbingInterval
        });

        new events.Rule(this, 'ScheduleRule', {
            schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
            targets: [new targets.SfnStateMachine(stepFunctionConstruct.stateMachine)],
        });

        new cdk.CfnOutput(this, 'ProbingLambdaSecurityGroup', {
            value: probingLambdaSG.securityGroupId,
            description: 'Probing Lambda SecurityGroup.'
        });

        new cdk.CfnOutput(this, 'RouteTablesUnderManagement', {
            value: clientRTIds.toString(),
            description: 'RouteTables under active management'
        });
    }
}