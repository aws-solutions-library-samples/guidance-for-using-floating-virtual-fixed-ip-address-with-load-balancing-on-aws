import * as cdk from 'aws-cdk-lib';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sfntasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';


export interface StepFunctionStackProps {
    lambdaProbing: lambda.IFunction,
    lambdaFailover: lambda.IFunction,
    contextTable: dynamodb.ITable,
    probingFailedThreshold: number;
    probingInterval: number;
}

export class StepFunctionConstruct extends Construct {
    public readonly stateMachine: sfn.StateMachine;

    constructor(scope: Construct, id: string, props: StepFunctionStackProps) {
        super(scope, id);

        if (props.probingInterval >= 60) {
            throw new Error('\'probingWaitTime\' must be smaller than 60'); // must be smaller than 60 otherwis, execution of step function flows will overlap.
        }
        const totalStateMachineRounds = Math.floor(60 / (props.probingInterval + 1)); // how many times till the state machine finishes: 60 sek / (waitingTime between health checks + 1 sek buffer)

        // Step Function Definition
        const dynamoDbGetContext = new sfntasks.DynamoGetItem(this, 'GetContext', {
            key: { attrName: sfntasks.DynamoAttributeValue.fromString('runContext') },
            table: props.contextTable,
        });

        const transformContextFromDynamoDB = new sfn.Pass(this, 'TransformDynamoResult', {
            parameters: {
                'failureCounter.$': 'States.StringToJson($.Item.failureCounter.S)',//this will handle number just fine
                'result.$': '$.Item.result.S'
            }
        });

        const setDefaultContextValues = new sfn.Pass(this, 'SetDefaultContextValues', {
            parameters: {
                'failureCounter': 0,
                'result': 'SUCCESS',
                'counter': 0
            }
        });

        const checkIfContextExists = new sfn.Choice(this, 'CheckIfContextExists')
            .when(sfn.Condition.isPresent('$.Item'), transformContextFromDynamoDB)
            .otherwise(setDefaultContextValues);

        const wait = new sfn.Wait(this, 'Wait', {
            time: sfn.WaitTime.duration(cdk.Duration.seconds(props.probingInterval)),
        });

        const lambdaProbingTask = new sfntasks.LambdaInvoke(this, 'LambdaProbing', {
            lambdaFunction: props.lambdaProbing,
            outputPath: '$.Payload'
        });

        const lambdaFailoverTask = new sfntasks.LambdaInvoke(this, 'LambdaFailover', {
            lambdaFunction: props.lambdaFailover,
            outputPath: '$.Payload',
        });

        const dynamoDbPutContext = new sfntasks.DynamoPutItem(this, 'PutContext', {
            table: props.contextTable,
            item: {
                attrName: sfntasks.DynamoAttributeValue.fromString('runContext'),
                result: sfntasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.result')),
                counter: sfntasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('States.JsonToString($.counter)')),
                failureCounter: sfntasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('States.JsonToString($.failureCounter)')),
            },
        });

        const choiceCounter = new sfn.Choice(this, 'ChoiceCounter?')
            .when(
                sfn.Condition.numberGreaterThanEquals('$.counter', totalStateMachineRounds),
                dynamoDbPutContext
            )
            .otherwise(wait
                .next(lambdaProbingTask)
            )

        const choiceFailure = new sfn.Choice(this, 'ChoiceFailure?')
            .when(
                sfn.Condition.and(
                    sfn.Condition.stringEquals('$.result', 'FAILURE'),
                    sfn.Condition.numberGreaterThanEquals('$.failureCounter', props.probingFailedThreshold)
                ),
                lambdaFailoverTask
                    .next(choiceCounter)
            )
            .otherwise(choiceCounter);

        transformContextFromDynamoDB.next(lambdaProbingTask);
        setDefaultContextValues.next(lambdaProbingTask);
        lambdaProbingTask.next(choiceFailure);

        const definitionBody = sfn.DefinitionBody.fromChainable(
            dynamoDbGetContext
                .next(checkIfContextExists)
        );

        this.stateMachine = new sfn.StateMachine(this, 'FloatingIP-StateMachine', {
            stateMachineName: 'FloatingIP-StateMachine',
            definitionBody: definitionBody,
            timeout: cdk.Duration.minutes(1), // run state machine every minute
        });
    }
}