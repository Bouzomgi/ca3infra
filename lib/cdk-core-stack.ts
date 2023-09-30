import env from '../config'
import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as s3 from 'aws-cdk-lib/aws-s3'
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'

const awsEnv = {
  env: {
    region: env.CDK_DEFAULT_REGION,
    account: env.CDK_DEFAULT_ACCOUNT
  }
}

// CREATE VPC AND SUBNETS, RDS INSTANCE, S3 WEBSERVER, CLOUDFRONT DISTRIBUTION

export class CdkCoreStack extends Stack {
  vpc: ec2.Vpc
  webserverBucket: s3.Bucket

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props ? Object.assign(props, awsEnv) : awsEnv)

    // CREATE VPC & SUBNETS
    const vpc = new ec2.Vpc(this, 'ca3-vpc', {
      availabilityZones: ['us-east-1a', 'us-east-1b'],
      natGatewaySubnets: {
        availabilityZones: ['us-east-1a'],
        subnetType: ec2.SubnetType.PUBLIC
      },
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 20,
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC
        },
        {
          cidrMask: 20,
          name: 'server',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
        }
      ],
      vpcName: 'ca3-vpc'
    })

    this.vpc = vpc

    // CREATE RDS SECURITY GROUP
    const rdsSecurityGroup = new ec2.SecurityGroup(
      this,
      'ca3-rds-security-group',
      {
        vpc: vpc
      }
    )

    rdsSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(3306))

    // CREATE RDS INSTANCE
    new rds.DatabaseInstance(this, 'ca3-rds-instance', {
      engine: rds.DatabaseInstanceEngine.MYSQL,
      vpc: vpc,
      allocatedStorage: 20,
      availabilityZone: 'us-east-1a',
      credentials: {
        secretName: 'ca3-rds-creds',
        username: 'admin'
      },
      databaseName: 'ca3db',
      deletionProtection: false,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO
      ),
      securityGroups: [rdsSecurityGroup],
      port: 3306,
      vpcSubnets: {
        subnetGroupName: 'server'
      }
    })

    // CREATE S3 BUCKET FOR WEBSERVER
    const webserverBucket = new s3.Bucket(this, 'ca3-webserver', {
      autoDeleteObjects: true,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicPolicy: false,
        blockPublicAcls: false,
        ignorePublicAcls: false,
        restrictPublicBuckets: false
      }),
      bucketName: 'ca3-webserver',
      publicReadAccess: true,
      removalPolicy: RemovalPolicy.DESTROY,
      websiteIndexDocument: 'index.html'
    })

    // CREATE CLOUDFRONT DISTRIBUTION
    const certificateArn = env.ARN_CLOUDFRONT_CERTIFICATE

    const appDistribution = new cloudfront.Distribution(
      this,
      'ca3-cloudfront-distribution',
      {
        defaultBehavior: {
          origin: new origins.S3Origin(webserverBucket)
        },
        certificate: Certificate.fromCertificateArn(
          this,
          'ca3-certificate',
          certificateArn
        ),
        defaultRootObject: 'index.html',
        domainNames: [env.DOMAIN_NAME],
        geoRestriction: cloudfront.GeoRestriction.allowlist('US')
      }
    )

    this.webserverBucket = webserverBucket
  }
}
