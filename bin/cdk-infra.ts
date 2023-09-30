import * as cdk from 'aws-cdk-lib'
import { CdkCoreStack } from '../lib/cdk-core-stack'
import { CdkInfraStack } from '../lib/cdk-infra-stack'

const app = new cdk.App()

const cdkCoreStack = new CdkCoreStack(app, 'CdkCoreStack')

new CdkInfraStack(app, 'CdkInfraStack', {
  vpc: cdkCoreStack.vpc,
  webserverBucket: cdkCoreStack.webserverBucket
})
