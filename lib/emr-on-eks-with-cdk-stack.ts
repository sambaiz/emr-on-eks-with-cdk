import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as emrcontainers from 'aws-cdk-lib/aws-emrcontainers';
import * as basex from 'base-x';
import { KubectlV27Layer } from '@aws-cdk/lambda-layer-kubectl-v27';

export class EmrOnEksWithCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const cluster = this.createEKSCluster("emr-on-eks-test")

    const emrcontainersNamespace = 'emrcontainers'

    const virtualCluster = this.registerClusterToEMR(cluster, emrcontainersNamespace)

    const jobExecutionRole = this.createJobExecutionRole(cluster, emrcontainersNamespace)

    new cdk.CfnOutput(this, 'JobExecutionEnvOutput', {
      value: `export VIRTUAL_CLUSTER_ID=${virtualCluster.attrId} EXECUTION_ROLE_ARN=${jobExecutionRole.roleArn}`
    })
  }

  createEKSCluster(clusterName: string) {
    const vpc = new ec2.Vpc(this, 'VPC', {
      ipAddresses: ec2.IpAddresses.cidr('10.18.0.0/18'),
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 20,
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 20,
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ]
    })
    cdk.Tags.of(vpc).add("Name", clusterName)

    const mastersRole = new iam.Role(this, 'MastersRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('eks.amazonaws.com'),
        new iam.AccountRootPrincipal(),
      ),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSClusterPolicy'),
      ],
    })

    return new eks.Cluster(this, 'EKSCluster', {
      vpc,
      mastersRole,
      clusterName: clusterName,
      version: eks.KubernetesVersion.V1_27,
      kubectlLayer: new KubectlV27Layer(this, 'KubectlLayer'),
      defaultCapacity: 3,
      defaultCapacityInstance: new ec2.InstanceType('m5.large')
    })
  }

  registerClusterToEMR(cluster: eks.Cluster, emrcontainersNamespace: string) {
    const namespace = cluster.addManifest('EMRContainersNamespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: emrcontainersNamespace }
    })

    // https://github.com/eksctl-io/eksctl/blob/4fb29ad0bc523126ea837d1b7061eb639a65bfa4/pkg/authconfigmap/assets/emr-containers-rbac.yaml#L4
    const emrRole = cluster.addManifest('EMRContainersRole', {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: { name: 'emr-containers', namespace: emrcontainersNamespace },
      rules: [
        { apiGroups: [''], resources: ['namespaces'], verbs: ['get'] },
        { apiGroups: [''], resources: ['serviceaccounts', 'services', 'configmaps', 'events', 'pods', 'pods/log'], verbs: ['get', 'list', 'watch', 'describe', 'create', 'edit', 'delete', 'deletecollection', 'annotate', 'patch', 'label'] },
        { apiGroups: [''], resources: ['secrets'], verbs: ['create', 'patch', 'delete', 'watch'] },
        { apiGroups: ['apps'], resources: ['statefulsets', 'deployments'], verbs: ['get', 'list', 'watch', 'describe', 'create', 'edit', 'delete', 'annotate', 'patch', 'label'] },
        { apiGroups: ['batch'], resources: ['jobs'], verbs: ['get', 'list', 'watch', 'describe', 'create', 'edit', 'delete', 'annotate', 'patch', 'label'] },
        { apiGroups: ['extensions', 'networking.k8s.io'], resources: ['ingresses'], verbs: ['get', 'list', 'watch', 'describe', 'create', 'edit', 'delete', 'annotate', 'patch', 'label'] },
        { apiGroups: ['rbac.authorization.k8s.io'], resources: ['roles', 'rolebindings'], verbs: ['get', 'list', 'watch', 'describe', 'create', 'edit', 'delete', 'deletecollection', 'annotate', 'patch', 'label'] },
        { apiGroups: [''], resources: ['persistentvolumeclaims'], verbs: ['create', 'list', 'delete']},
        { apiGroups: ['scheduling.volcano.sh'], resources: ['podgroups'], verbs: ['get', 'list', 'watch', 'create', 'delete', 'update']}
      ],
    });
    emrRole.node.addDependency(namespace)

    const emrRoleBind = cluster.addManifest('EMRContainersRoleBind', {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: { name: 'emr-containers', namespace: emrcontainersNamespace },
      subjects: [{ kind: 'User', name: 'emr-containers', apiGroup: 'rbac.authorization.k8s.io' }],
      roleRef: { kind: 'Role', name: 'emr-containers', apiGroup: 'rbac.authorization.k8s.io' },
    });
    emrRoleBind.node.addDependency(emrRole);

    const emrContainersRole = iam.Role.fromRoleName(this, 'EMRContainersRole',
      'AWSServiceRoleForAmazonEMRContainers')

    cluster.awsAuth.addRoleMapping(emrContainersRole, {
      username: "emr-containers",
      groups: []
    })

    const virtualCluster = new emrcontainers.CfnVirtualCluster(this, 'VirtualCluster', {
      name: cluster.clusterName,
      containerProvider: {
        id: cluster.clusterName,
        type: 'EKS',
        info: {
          eksInfo: {
            namespace: emrcontainersNamespace
          }
        }
      }
    })

    virtualCluster.node.addDependency(emrRoleBind);
    virtualCluster.node.addDependency(cluster.awsAuth);

    return virtualCluster
  }

  createJobExecutionRole(cluster: eks.Cluster, emrcontainersNamespace: string) {
    const roleName = "emr-on-eks-test-job-execution-role"
    const bs36 = basex("0123456789abcdefghijklmnopqrstuvwxyz")
    const base36RoleName = bs36.encode(new TextEncoder().encode(roleName))

    return new iam.Role(this, 'EMRJobExecutionRole', {
      roleName: roleName,
      assumedBy: new iam.WebIdentityPrincipal(
        cluster.openIdConnectProvider.openIdConnectProviderArn,
        {
          "StringLike": new cdk.CfnJson(this, 'JobExecutionRoleStringEquals', { value: {
              [`${cluster.clusterOpenIdConnectIssuer}:sub`]: `system:serviceaccount:${emrcontainersNamespace}:emr-containers-sa-*-*-${this.account}-${base36RoleName}`
            }})
        }
      ),
      inlinePolicies: {
        'job-execution-policy': new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                's3:PutObject',
                's3:GetObject',
                's3:ListBucket'
              ],
              resources: ['arn:aws:s3:::*'],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'logs:PutLogEvents',
                'logs:CreateLogStream',
                'logs:DescribeLogGroups',
                'logs:DescribeLogStreams'
              ],
              resources: ['arn:aws:logs:*:*:*'],
            })
          ]
        })
      }
    })
  }
}
