import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import * as path from 'path';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';

export class VpcStack extends cdk.Stack {

    public readonly targetSubnets: ec2.ISubnet[];

    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // VPC with 4 private subnets
        const vpc = new ec2.Vpc(this, 'VPC', {
            maxAzs: 2,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'VPC-prv-Client',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED
                },
                {
                    cidrMask: 24,
                    name: 'VPC-prv-Target',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED
                }
            ],
        });

        // Get Client subnets
        const clientSubnets = vpc.selectSubnets({
            subnetGroupName: 'VPC-prv-Client',
        }).subnets;

        // Get Target subnets
        this.targetSubnets = vpc.selectSubnets({
            subnetGroupName: 'VPC-prv-Target',
        }).subnets;

        const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup-vpc-default', {
            vpc: vpc,
            allowAllOutbound: true
        });

        securityGroup.addIngressRule(
            ec2.Peer.ipv4(vpc.vpcCidrBlock),
            ec2.Port.allTraffic(),
            'Allow all traffic from VPC'
        )

        new ec2.InterfaceVpcEndpoint(this, 'SystemsManagerEndpoint', {
            vpc,
            service: ec2.InterfaceVpcEndpointAwsService.SSM,
            privateDnsEnabled: true,
            securityGroups: [securityGroup]
        });

        new ec2.InterfaceVpcEndpoint(this, 'EC2MessagesEndpoint', {
            vpc,
            service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
            privateDnsEnabled: true,
            securityGroups: [securityGroup]
        });

        new ec2.InterfaceVpcEndpoint(this, 'SSMMessagesEndpoint', {
            vpc,
            service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
            privateDnsEnabled: true,
            securityGroups: [securityGroup]
        });

        new ec2.InterfaceVpcEndpoint(this, 'CloudWatchLogsEndpoint', {
            vpc,
            service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
            privateDnsEnabled: true,
            securityGroups: [securityGroup]
        });

        new ec2.InterfaceVpcEndpoint(this, 'CloudWatchMonitoringEndpoint', {
            vpc,
            service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING,
            privateDnsEnabled: true,
            securityGroups: [securityGroup]
        });

        vpc.addGatewayEndpoint('S3GatewayEndpoint', {
            service: ec2.GatewayVpcEndpointAwsService.S3,
        });



        const ec2Instance1 = new ec2.Instance(this, 'EC2Instance1', {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage: new ec2.AmazonLinuxImage(),
            vpc: vpc,
            vpcSubnets: vpc.selectSubnets({
                subnetGroupName: 'VPC-prv-Target',

            }),
            securityGroup: securityGroup,
            sourceDestCheck: false
        });

        const ec2Instance2 = new ec2.Instance(this, 'EC2Instance2', {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            machineImage: new ec2.AmazonLinuxImage(),
            vpc: vpc,
            vpcSubnets: vpc.selectSubnets({
                subnetGroupName: 'VPC-prv-Target',
            }),
            securityGroup: securityGroup,
            sourceDestCheck: false
        });

        const asset = new Asset(this, 'eth0-logical-ip', {
            path: path.join(__dirname, 'eth0:0')
        });
        asset.grantRead(ec2Instance1.role);
        asset.grantRead(ec2Instance2.role);

        // Configuration of the instance to allow logical IP - in this case 20.0.0.10
        // Installs apache HTTP Server to answer HTTP requests
        ec2Instance1.addUserData(
            `aws s3 cp s3://${asset.s3BucketName}/${asset.s3ObjectKey} /tmp/ifcfg-eth0:0`,
            `mv /tmp/ifcfg-eth0:0 /etc/sysconfig/network-scripts/ifcfg-eth0:0`,
            `service network restart`,
            'yum -y install httpd',
            `service httpd restart`,
            `touch /var/www/html/index.html`
        );
        ec2Instance2.addUserData(
            `aws s3 cp s3://${asset.s3BucketName}/${asset.s3ObjectKey} /tmp/ifcfg-eth0:0`,
            `mv /tmp/ifcfg-eth0:0 /etc/sysconfig/network-scripts/ifcfg-eth0:0`,
            `service network restart`,
            'yum -y install httpd',
            `service httpd restart`,
            `touch /var/www/html/index.html`
        );

        new cdk.CfnOutput(this, 'Floating-IP', {
            value: '20.0.0.10',
            description: 'Floating IP'
        });
        new cdk.CfnOutput(this, 'VpcId', {
            value: vpc.vpcId,
            description: 'VpcID of the created VPC'
        });
        new cdk.CfnOutput(this, 'ClientSubnetIds', {
            value: clientSubnets.map(s => s.subnetId).join(','),
            description: 'Comma separated SubnetIDs the subnets meant for clients of the Floating IP.'
        });

        // Create a custom resource to fetch the ENI IDs for both instances
        const getEniIds = new cr.AwsCustomResource(this, 'GetEniIds', {
            onUpdate: {
                service: 'EC2',
                action: 'describeInstances',
                parameters: {
                    InstanceIds: [ec2Instance1.instanceId, ec2Instance2.instanceId]
                },
                physicalResourceId: cr.PhysicalResourceId.of(Date.now().toString()),
                outputPaths: [
                    'Reservations.0.Instances.0.NetworkInterfaces.0.NetworkInterfaceId',
                    'Reservations.1.Instances.0.NetworkInterfaces.0.NetworkInterfaceId'
                ]
            },
            policy: cr.AwsCustomResourcePolicy.fromStatements([
                new iam.PolicyStatement({
                    actions: ['ec2:DescribeInstances'],
                    resources: ['*'],
                    effect: iam.Effect.ALLOW
                })
            ]),
            installLatestAwsSdk: false
        });

        const eniId1 = getEniIds.getResponseField('Reservations.0.Instances.0.NetworkInterfaces.0.NetworkInterfaceId');
        const eniId2 = getEniIds.getResponseField('Reservations.1.Instances.0.NetworkInterfaces.0.NetworkInterfaceId');

        new cdk.CfnOutput(this, 'TargetEniPrimaryInstance', {
            value: eniId1,
            description: 'The ENI of a primary EC2 instance.'
        });
        new cdk.CfnOutput(this, 'TargetEniSecondaryInstance', {
            value: eniId2,
            description: 'The ENI of a secondary EC2 instance.'
        });

    }
}
