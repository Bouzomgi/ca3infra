import env from '../config'
import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as route53 from 'aws-cdk-lib/aws-route53'
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets'
import * as ssm from 'aws-cdk-lib/aws-ssm'

const awsEnv = {
  env: {
    region: env.CDK_DEFAULT_REGION,
    account: env.CDK_DEFAULT_ACCOUNT
  }
}

export class CdkInfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props ? props : awsEnv)

    const applicationName = 'ca3'

    // CREATE VPC & SUBNETS
    const vpc = new ec2.Vpc(this, `${applicationName}-vpc`, {
      availabilityZones: ['us-east-1a', 'us-east-1b'],
      natGatewaySubnets: {
        availabilityZones: ['us-east-1a'],
        subnetType: ec2.SubnetType.PUBLIC
      },
      natGateways: 1,
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
      vpcName: `${applicationName}-vpc`
    })

    // CREATE S3 BUCKET FOR WEBSERVER
    const webserverBucket = new s3.Bucket(
      this,
      `${applicationName}-webserver`,
      {
        autoDeleteObjects: true,
        blockPublicAccess: new s3.BlockPublicAccess({
          blockPublicPolicy: false,
          blockPublicAcls: false,
          ignorePublicAcls: false,
          restrictPublicBuckets: false
        }),
        bucketName: `${applicationName}-webserver`,
        publicReadAccess: true,
        removalPolicy: RemovalPolicy.DESTROY,
        websiteIndexDocument: 'index.html'
      }
    )

    // GET REFERENCES TO EXISTING ROLES TO BE USED BY ECS
    const ecsEcrAdmin = iam.Role.fromRoleArn(
      this,
      'ecs-ecr-admin',
      env.ARN_ECS_ECR_ADMIN
    )
    const ecsTaskExecutionRole = iam.Role.fromRoleArn(
      this,
      'ecs-task-execution-role',
      env.ARN_ECS_TASK_EXECUTION
    )

    // CREATE ECS CLUSTER
    const cluster = new ecs.Cluster(this, `${applicationName}-cluster`, {
      clusterName: `${applicationName}`,
      vpc: vpc,
      enableFargateCapacityProviders: true
    })

    // CREATE LOG DRIVERS FOR APPSERVER
    const logGroup = new logs.LogGroup(this, `${applicationName}-log-group`)

    const appserverLogDriver = ecs.LogDriver.awsLogs({
      streamPrefix: 'appserver',
      logGroup
    })

    const dbUsername = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'db_username_param',
      {
        parameterName: '/ca3be/prod/db_username'
      }
    )

    const dbPassword = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'db_password_param',
      {
        parameterName: '/ca3be/prod/db_password'
      }
    )

    const dbHost = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'db_host_param',
      {
        parameterName: '/ca3be/prod/db_host'
      }
    )

    const dbName = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'db_name_param',
      {
        parameterName: '/ca3be/prod/db_name'
      }
    )

    // CREATE APPSERVER ECS TASKDEFINITION & CONTAINER
    const appserverTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      `${applicationName}-appserver-taskdefiniton`,
      {
        cpu: 256,
        family: `${applicationName}-appserver-taskdefintion`,
        executionRole: ecsEcrAdmin,
        taskRole: ecsTaskExecutionRole
      }
    )
    appserverTaskDefinition.addContainer('appserver', {
      image: ecs.ContainerImage.fromRegistry(env.BACKEND_ECR_REGISTRY_NAME),
      containerName: 'appserver',
      cpu: 0,
      environment: {
        PORT: '80',
        FRONTEND_ENDPOINT: ssm.StringParameter.valueFromLookup(
          this,
          '/ca3be/prod/frontend_endpoint'
        )
      },
      secrets: {
        DB_USERNAME: ecs.Secret.fromSsmParameter(dbUsername),
        DB_PASSWORD: ecs.Secret.fromSsmParameter(dbPassword),
        DB_HOST: ecs.Secret.fromSsmParameter(dbHost),
        DB_NAME: ecs.Secret.fromSsmParameter(dbName)
      },
      logging: appserverLogDriver,
      portMappings: [
        {
          name: 'appserver-80-tcp',
          containerPort: 80,
          hostPort: 80
        }
      ]
    })

    // CREATE WEB SERVER SECURITY GROUP
    const appserverSecurityGroup = new ec2.SecurityGroup(
      this,
      `${applicationName}-server-security-group`,
      {
        vpc: vpc,
        allowAllOutbound: true
      }
    )

    // CREATE LOAD BALANCER SECURITY GROUP
    const loadBalancerSecurityGroup = new ec2.SecurityGroup(
      this,
      `${applicationName}-loadbalancer-security-group`,
      {
        vpc: vpc,
        allowAllOutbound: true
      }
    )

    // update these!!!
    appserverSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.allTraffic()
    )

    loadBalancerSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.allTraffic()
    )

    // RUN APPSERVER TASK DEFINITIONS
    const appserverService = new ecs.FargateService(this, 'appserver-service', {
      assignPublicIp: true,
      cluster,
      securityGroups: [appserverSecurityGroup],
      serviceName: 'appserver-service',
      taskDefinition: appserverTaskDefinition,
      vpcSubnets: {
        subnetGroupName: 'server'
      }
    })

    // CREATE FRONTEND ALB
    const frontendLoadBalancer = new elbv2.ApplicationLoadBalancer(
      this,
      `${applicationName}-frontend-load-balancer`,
      {
        vpc,
        internetFacing: true,
        securityGroup: loadBalancerSecurityGroup,
        vpcSubnets: {
          subnetGroupName: 'public'
        }
      }
    )

    // GET LOAD BALANCER TARGET FOR APPSERVER
    const appserverTarget = appserverService.loadBalancerTarget({
      containerName: 'appserver',
      containerPort: 80
    })

    // CREATE TARGET GROUP FOR APPSERVER
    const appserverTargetGroup = new elbv2.ApplicationTargetGroup(
      this,
      'appserver-tg',
      {
        healthCheck: {
          path: '/backend'
        },
        port: 80,
        targets: [appserverTarget],
        vpc: vpc
      }
    )

    // CREATE LISTENER AND ASSIGN TARGET GROUPS
    const frontendListener = frontendLoadBalancer.addListener(
      'frontend-listener',
      {
        port: 80
      }
    )

    frontendListener.addTargetGroups('appserver-targets', {
      targetGroups: [appserverTargetGroup]
    })

    const certificateArn = env.ARN_CLOUDFRONT_CERTIFICATE

    // CREATE CLOUDFRONT DISTRIBUTION
    const appDistribution = new cloudfront.Distribution(
      this,
      `${applicationName}-cloudfront-distribution`,
      {
        defaultBehavior: {
          origin: new origins.S3Origin(webserverBucket)
        },
        additionalBehaviors: {
          '/backend/*': {
            cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
            origin: new origins.LoadBalancerV2Origin(frontendLoadBalancer, {
              protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY
            }),
            originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER
          }
        },
        certificate: Certificate.fromCertificateArn(
          this,
          `${applicationName}-certificate`,
          certificateArn
        ),
        defaultRootObject: 'index.html',
        domainNames: [env.DOMAIN_NAME],
        geoRestriction: cloudfront.GeoRestriction.allowlist('US')
      }
    )

    // REASSIGN ROUTE53 URL TO POINT TO FRONTEND ALB
    const zone = route53.HostedZone.fromLookup(
      this,
      `${applicationName}-hosted-zone`,
      {
        domainName: env.DOMAIN_NAME
      }
    )

    new route53.ARecord(this, 'AliasRecord', {
      zone,
      target: route53.RecordTarget.fromAlias(
        new CloudFrontTarget(appDistribution)
      )
    })
  }
}

module.exports = { CdkInfraStack }
