import { CloudFormationCustomResourceEvent, CloudFormationCustomResourceResponse } from 'aws-lambda';
import { EC2Client, DescribeRouteTablesCommand } from "@aws-sdk/client-ec2";

const ec2Client = new EC2Client();

// returns the RouteTableID of a specified Subnet
export const handler = async (event: CloudFormationCustomResourceEvent): Promise<CloudFormationCustomResourceResponse> => {
	console.log('Event:', JSON.stringify(event, null, 2));

	const inputParameter = event.ResourceProperties.InputParameter;

	let responseData: { routeTableId: string };
	let physicalResourceId: string;

	if (event.RequestType === 'Create') {
		// For Create, generate a new ID
		physicalResourceId = `SubnetCustomResource-${Date.now()}`;
	} else {
		// For Update and Delete, use the existing ID
		physicalResourceId = event.PhysicalResourceId;
	}

	try {
		const command = new DescribeRouteTablesCommand({
			Filters: [
				{
					Name: "association.subnet-id",
					Values: [inputParameter],
				},
			],
		});

		const response = await ec2Client.send(command);

		if (response.RouteTables && response.RouteTables.length > 0) {
			responseData = { routeTableId: response.RouteTables[0].RouteTableId ?? '--' }
		} else {
			throw new Error(`No route table found for subnet ${inputParameter}`);
		}

		console.log('Response Data: %s', JSON.stringify(responseData));

		return {
			Status: 'SUCCESS',
			RequestId: event.RequestId,
			LogicalResourceId: event.LogicalResourceId,
			StackId: event.StackId,
			PhysicalResourceId: physicalResourceId,
			Data: responseData
		};
	} catch (error) {
		console.error('Error:', error);

		return {
			Status: 'FAILED',
			RequestId: event.RequestId,
			LogicalResourceId: event.LogicalResourceId,
			StackId: event.StackId,
			PhysicalResourceId: 'SubnetCustomResourcePhysicalID',
			Reason: `Error: ${error}`,
		};
	}
};