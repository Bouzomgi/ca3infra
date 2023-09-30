import env from '../config'
import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as cdk from 'aws-cdk-lib'
import * as rds from 'aws-cdk-lib/aws-rds'
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
import * as secretsManager from 'aws-cdk-lib/aws-secretsmanager'

const awsEnv = {
  env: {
    region: env.CDK_DEFAULT_REGION,
    account: env.CDK_DEFAULT_ACCOUNT
  }
}

export interface InfraStackProps extends cdk.StackProps {
  vpc: ec2.Vpc
  webserverBucket: s3.Bucket
}

export class CdkInfraStack extends Stack {
  constructor(scope: Construct, id: string, props: InfraStackProps) {
    super(scope, id, Object.assign(props, awsEnv))

    const vpc = props.vpc
    const webserverBucket = props.webserverBucket

    const natGatewaySubnet = vpc.publicSubnets.filter(
      (elem) => elem.availabilityZone == 'us-east-1a'
    )[0]

    const natGatewayEip = new ec2.CfnEIP(this, 'nat-gateway-eip')

    // ADD NAT GATEWAY TO PUBLIC SUBNET
    const natGateway = new ec2.CfnNatGateway(this, 'ca3-nat-gateway', {
      subnetId: natGatewaySubnet.subnetId,
      allocationId: natGatewayEip.attrAllocationId
    })

    // ADD ROUTES FROM PRIVATE SUBNETS TO PUBLIC SUBNETS
    vpc.privateSubnets.forEach((subnet, index) => {
      new ec2.CfnRoute(this, `subnet${index}-nat-route`, {
        routeTableId: subnet.routeTable.routeTableId,
        destinationCidrBlock: '0.0.0.0/0',
        natGatewayId: natGateway.attrNatGatewayId
      })
    })

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
    const cluster = new ecs.Cluster(this, 'ca3-cluster', {
      clusterName: 'ca3',
      vpc: vpc,
      enableFargateCapacityProviders: true
    })

    // CREATE LOG DRIVERS FOR APPSERVER
    const logGroup = new logs.LogGroup(this, 'ca3-log-group')

    const appserverLogDriver = ecs.LogDriver.awsLogs({
      streamPrefix: 'appserver',
      logGroup
    })

    // CREATE APPSERVER ECS TASKDEFINITION & CONTAINER
    const rdsLoginSecret = secretsManager.Secret.fromSecretNameV2(
      this,
      'ca3-rds-login-secret',
      'ca3-rds-creds'
    )

    const appserverTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      'ca3-appserver-taskdefiniton',
      {
        cpu: 256,
        family: 'ca3-appserver-taskdefiniton',
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
        DB_USERNAME: ecs.Secret.fromSecretsManager(rdsLoginSecret, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(rdsLoginSecret, 'password'),
        DB_DIALECT: ecs.Secret.fromSecretsManager(rdsLoginSecret, 'engine'),
        DB_NAME: ecs.Secret.fromSecretsManager(rdsLoginSecret, 'dbname'),
        DB_HOST: ecs.Secret.fromSecretsManager(rdsLoginSecret, 'host')
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
      'ca3-server-security-group',
      {
        vpc: vpc,
        allowAllOutbound: true
      }
    )

    // CREATE LOAD BALANCER SECURITY GROUP
    const loadBalancerSecurityGroup = new ec2.SecurityGroup(
      this,
      'ca3-loadbalancer-security-group',
      {
        vpc: vpc,
        allowAllOutbound: true
      }
    )

    appserverSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80))

    loadBalancerSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80)
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
      'ca3-frontend-load-balancer',
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

    // CREATE CLOUDFRONT DISTRIBUTION
    const certificateArn = env.ARN_CLOUDFRONT_CERTIFICATE

    const appDistribution = new cloudfront.Distribution(
      this,
      'ca3-cloudfront-distribution',
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
          'ca3-certificate',
          certificateArn
        ),
        defaultRootObject: 'index.html',
        domainNames: [env.DOMAIN_NAME],
        geoRestriction: cloudfront.GeoRestriction.allowlist('US')
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

    // REASSIGN ROUTE53 URL TO POINT TO FRONTEND ALB
    const zone = route53.HostedZone.fromLookup(this, 'ca3-hosted-zone', {
      domainName: env.DOMAIN_NAME
    })

    new route53.ARecord(this, 'AliasRecord', {
      zone,
      target: route53.RecordTarget.fromAlias(
        new CloudFrontTarget(appDistribution)
      )
    })
  }
}

module.exports = { CdkInfraStack }
