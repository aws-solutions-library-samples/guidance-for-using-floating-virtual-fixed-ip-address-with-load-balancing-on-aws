import { Handler } from 'aws-lambda';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

import { DescribeRouteTablesCommand, ReplaceRouteCommand, DescribeRouteTablesCommandInput, ReplaceRouteCommandInput, EC2Client } from '@aws-sdk/client-ec2';

const replaceRoute = async (routeTableId?: string, vIP?: string, eniId?: string) => {
    const input: ReplaceRouteCommandInput = {
        DestinationCidrBlock: vIP,
        NetworkInterfaceId: eniId,
        RouteTableId: routeTableId
    };
    const command = new ReplaceRouteCommand(input);
    return new EC2Client({}).send(command);
}

const config = {
    floatingIp: process.env.FLOATING_IP || '-',
    eniPrimary: process.env.ENI_PRIMARY,
    eniSecondary: process.env.ENI_SECONDARY,
    routeTables: process.env.ROUTE_TABLES?.split(','),
  };

export const handler: Handler = async (event: any) => {
    console.log(JSON.stringify(config));

    try {
        const input: DescribeRouteTablesCommandInput = {
            DryRun: false,
            RouteTableIds: config.routeTables
        };
        const response = await new EC2Client({}).send(new DescribeRouteTablesCommand(input));
        addFailoverMetric();

        for (const rt of response.RouteTables || []) {
            console.log('RouteTableId: \'%s\' Routes: \'%s\'', rt.RouteTableId, rt.Routes);

            let floatingIpRoute = rt.Routes?.find(r => r.DestinationCidrBlock === config.floatingIp);
            if (floatingIpRoute) {
                console.debug('RouteTable \'%s\' contains the route to floating IP \'%s\'', rt, config.floatingIp);

                if (floatingIpRoute.NetworkInterfaceId === config.eniPrimary) {
                    console.log('Changing from primary eni to secondary eni... New eni: %s', config.eniSecondary);
                    await replaceRoute(rt.RouteTableId, config.floatingIp, config.eniSecondary);
                } else {
                    console.log('Changing from secondary eni to primary eni... New eni: %s', config.eniPrimary);
                    await replaceRoute(rt.RouteTableId, config.floatingIp, config.eniPrimary);
                }
            }
        }
    } catch (error) {
        console.error('Error while doing failover. Config: %s', config, error);
        addErrorMetric();
    }

    return event;
}

const cwClient = new CloudWatchClient({});
async function addFailoverMetric() {
    return cwClient.send(new PutMetricDataCommand({
        MetricData: [
            {
                MetricName: "Failover",
                Dimensions: [
                    {
                        Name: "IP",
                        Value: config.floatingIp,
                    },
                ],
                Unit: "Count",
                Value: 1,
            },
        ],
        Namespace: "FloatingIP/Failover",
    }));
}

async function addErrorMetric() {
    return cwClient.send(new PutMetricDataCommand({
        MetricData: [
            {
                MetricName: "Error",
                Dimensions: [
                    {
                        Name: "IP",
                        Value: config.floatingIp,
                    },
                ],
                Unit: "Count",
                Value: 1,
            },
        ],
        Namespace: "FloatingIP/Failover",
    }));
}