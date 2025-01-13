#!/bin/bash

# Usage: sh prepare-cdk.sh <AWS-PROFILE-NAME>

# Set the CDK JSON file to update
cdk_json_file="cdk.json"

# Fetch stack outputs
stack_outputs=$(aws cloudformation describe-stacks --stack-name VpcStack --query 'Stacks[0].Outputs' --profile $1 --output json)

# Function to get output value by key
get_output_value() {
    echo $stack_outputs | jq -r ".[] | select(.OutputKey == \"$1\") | .OutputValue"
}

# Extract values from CloudFormation outputs
client_subnet_ids=$(get_output_value "ClientSubnetIds")
floating_ip=$(get_output_value "FloatingIP")
target_eni_primary=$(get_output_value "TargetEniPrimaryInstance")
target_eni_secondary=$(get_output_value "TargetEniSecondaryInstance")
vpc_id=$(get_output_value "VpcId")

# Update the CDK JSON file
jq --arg floating_ip "$floating_ip" \
   --arg vpc_id "$vpc_id" \
   --arg client_subnet_ids "$client_subnet_ids" \
   --arg target_eni_primary "$target_eni_primary" \
   --arg target_eni_secondary "$target_eni_secondary" \
   '.context.floating_ip = $floating_ip |
    .context.vpc_id = $vpc_id |
    .context.client_subnet_ids = $client_subnet_ids |
    .context.target_eni_primary = $target_eni_primary |
    .context.target_eni_secondary = $target_eni_secondary' \
   "$cdk_json_file" > tmp.json && mv tmp.json "$cdk_json_file"
