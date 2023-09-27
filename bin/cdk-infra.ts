import * as cdk from 'aws-cdk-lib'
import { CdkInfraStack } from '../lib/cdk-infra-stack'

const app = new cdk.App()
new CdkInfraStack(app, 'CdkInfraStack')
