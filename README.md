# amazon-ecs-blue-green-deploy

## はじめに

- ECSをブルーグリーンデプロイするためのデモ
- 次のサイトを参考にしています
  - https://docs.aws.amazon.com/ja_jp/AmazonECS/latest/developerguide/create-blue-green.html

## 前提条件

- aws-cliがインストール済み
- 各サービスを操作するための権限を有したIAMユーザのプロファイルを設定済み
- リージョンは `us-east-1`
- VPCはデフォルトのVPCを利用

## 構成

## 環境構築 by aws-cli

### デプロイするためのアプリケーションのイメージをECRに登録

リポジトリを作成

```sh
aws ecr create-repository --repository-name ecs-sample-web
aws ecr create-repository --repository-name ecs-sample-app
WebRepositoryUri=$(aws ecr describe-repositories \
    --query 'repositories[?repositoryName==`ecs-sample-web`].repositoryUri' --output text)
AppRepositoryUri=$(aws ecr describe-repositories \
    --query 'repositories[?repositoryName==`ecs-sample-app`].repositoryUri' --output text)
```

イメージをECRに登録

```sh
$(aws ecr get-login --no-include-email)
# ecs-sample-web
docker build -f docker/web/Dockerfile -t ${WebRepositoryUri}:latest .
docker push ${WebRepositoryUri}
# ecs-sample-app
docker build -f docker/app/Dockerfile -t ${AppRepositoryUri}:latest .
docker push ${AppRepositoryUri}
```

### セキュリティグループを作成

VPCIDを取得

```sh
VpcId=$(aws ec2 describe-vpcs --query 'Vpcs[?IsDefault==`true`].VpcId' --output text)
echo ${VpcId}
  # (e.g.) vpc-78549002
```

ALBのセキュリティグループを作成

```sh
aws ec2 create-security-group --description alb-sg --group-name alb-sg --vpc-id ${VpcId}
AlbSgId=$(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=${VpcId}" \
    --query 'SecurityGroups[?GroupName==`alb-sg`].GroupId' --output text)
echo ${AlbSgId}
  # (s.g.) sg-0bc2b9b788bbbb4ca
aws ec2 authorize-security-group-ingress --group-id ${AlbSgId} --protocol tcp --port 80 --cidr 0.0.0.0/0
```

ECSのセキュリティグループを作成

```sh
aws ec2 create-security-group --description ecs-sg --group-name ecs-sg --vpc-id ${VpcId}
EcsSgId=$(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=${VpcId}" \
    --query 'SecurityGroups[?GroupName==`ecs-sg`].GroupId' --output text)
echo ${EcsSgId}
  # (e.g.) sg-038b61a4a2e997021
aws ec2 authorize-security-group-ingress --group-id ${EcsSgId} --protocol tcp --port 80 --cidr 0.0.0.0/0
```

### IAMサービスロールを作成

ecsTaskExecutionRoleを作成

```sh
cat <<EOT > esc-task-execution-role-policy-document.json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "ecs-tasks.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOT
aws iam create-role --role-name ecsSampleTaskExecutionRole \
    --description "Allows ECS tasks to call AWS services on your behalf." \
    --assume-role-policy-document file://esc-task-execution-role-policy-document.json
aws iam attach-role-policy --role-name ecsSampleTaskExecutionRole \
    --policy-arn "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
EcsTaskExecutionRoleArn=$(aws iam get-role --role-name ecsSampleTaskExecutionRole \
    --query 'Role.Arn' --output text)
echo ${EcsTaskExecutionRoleArn}
  # (e.g.) arn:aws:iam::123456789012:role/ecsSampleTaskExecutionRole
```

ecsCodeDeployRoleを作成

```sh
cat <<EOT > esc-code-deploy-role-policy-document.json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "codedeploy.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOT
aws iam create-role --role-name ecsSampleCodeDeployRole \
    --description "Allows CodeDeploy to read S3 objects, invoke Lambda functions, publish to SNS topics, and update ECS services on your behalf." \
    --assume-role-policy-document file://esc-code-deploy-role-policy-document.json
aws iam attach-role-policy --role-name ecsSampleCodeDeployRole \
    --policy-arn "arn:aws:iam::aws:policy/AWSCodeDeployRoleForECS"
EcsCodeDeployRoleArn=$(aws iam get-role --role-name ecsSampleCodeDeployRole \
    --query 'Role.Arn' --output text)
echo ${EcsCodeDeployRoleArn}
  # (e.g.) arn:aws:iam::123456789012:role/ecsSampleCodeDeployRole
```

### Application Load Balancer を作成

サブネットIDを取得

```sh
SubnetIds=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=${VpcId}" \
    --query 'Subnets[].SubnetId' --output text | cut -f-2)
echo ${SubnetIds}
  # (e.g.) subnet-6439c35a subnet-3b833267
```

ALBを作成

```sh
aws elbv2 create-load-balancer \
    --name ecs-sample-alb \
    --subnets ${SubnetIds} \
    --security-groups ${AlbSgId}

LoadBalancerArn=$(aws elbv2 describe-load-balancers --names ecs-sample-alb \
    --query 'LoadBalancers[].LoadBalancerArn' --output text)
DNSName=$(aws elbv2 describe-load-balancers --names ecs-sample-alb \
    --query 'LoadBalancers[].DNSName' --output text)
echo ${LoadBalancerArn}; echo ${DNSName}
  # (e.g.) arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/ecs-sample-alb/88a9dbaad271da6e
  # (e.g.) ecs-sample-alb-1919540873.us-east-1.elb.amazonaws.com
```

ターゲットグループを作成

```sh
aws elbv2 create-target-group \
    --name ecs-sample-tg1 \
    --protocol HTTP \
    --port 80 \
    --target-type ip \
    --vpc-id ${VpcId}

TargetGroup1Arn=$(aws elbv2 describe-target-groups --names ecs-sample-tg1 \
    --query 'TargetGroups[].TargetGroupArn' --output text)
echo ${TargetGroup1Arn}
  # (e.g.) arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/ecs-sample-tg1/439443992dad8c1c
```

リスナー作成

```sh
aws elbv2 create-listener \
    --load-balancer-arn ${LoadBalancerArn} \
    --protocol HTTP \
    --port 80 \
    --default-actions Type=forward,TargetGroupArn=${TargetGroup1Arn}

ListenerArn=$(aws elbv2 describe-listeners --load-balancer-arn ${LoadBalancerArn} \
    --query 'Listeners[].ListenerArn' --output text)
echo ${ListenerArn}
  # (e.g.) arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/ecs-sample-alb/88a9dbaad271da6e/091d29198f3fa606
```

### Amazon ECS クラスターを作成

```sh
aws ecs create-cluster --cluster-name ecs-sample-cluster

ClusterArn=$(aws ecs describe-clusters --cluster ecs-sample-cluster \
    --query 'clusters[].clusterArn' --output text)
echo ${ClusterArn}
  # (e.g.) arn:aws:ecs:us-east-1:123456789012:cluster/ecs-sample-cluster
```

### タスク定義を登録

```sh
aws logs create-log-group --log-group-name /ecs/ecs-sample

cat <<EOT > ecs-sample-task-definition.json
{
  "family": "ecs-sample",
  "networkMode": "awsvpc",
  "containerDefinitions": [
    {
      "name": "web",
      "image": "${WebRepositoryUri}:latest",
      "portMappings": [
        {
          "containerPort": 80,
          "hostPort": 80,
          "protocol": "tcp"
        }
      ],
      "essential": true,
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/ecs-sample",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "web"
        }
      }
    },
    {
      "name": "app",
      "image": "${AppRepositoryUri}:latest",
      "essential": true,
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/ecs-sample",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "app"
        }
      }
    }
  ],
  "requiresCompatibilities": [
    "FARGATE"
  ],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "${EcsTaskExecutionRoleArn}"
}
EOT

aws ecs register-task-definition --cli-input-json file://ecs-sample-task-definition.json
TaskDefinitionArn=$(aws ecs describe-task-definition --task-definition ecs-sample \
    --query 'taskDefinition.taskDefinitionArn' --output text)
echo ${TaskDefinitionArn}
  # (e.g.) arn:aws:ecs:us-east-1:123456789012:task-definition/ecs-sample:5
```

### Amazon ECS サービスを作成

```sh
ids=($(for id in ${SubnetIds}; do echo \"$id\"; done))
subnets=$(IFS=","; echo "${ids[*]}")

cat <<EOT > ecs-sample-service.json
{
  "cluster": "ecs-sample-cluster",
  "serviceName": "ecs-sample-service",
  "taskDefinition": "ecs-sample",
  "loadBalancers": [
    {
      "targetGroupArn": "${TargetGroup1Arn}",
      "containerName": "web",
      "containerPort": 80
    }
  ],
  "launchType": "FARGATE",
  "schedulingStrategy": "REPLICA",
  "deploymentController": {
    "type": "CODE_DEPLOY"
  },
  "platformVersion": "LATEST",
  "networkConfiguration": {
    "awsvpcConfiguration": {
      "assignPublicIp": "ENABLED",
      "securityGroups": [ "${EcsSgId}" ],
      "subnets": [ ${subnets} ]
    }
  },
  "desiredCount": 1
}
EOT

aws ecs create-service --cli-input-json file://ecs-sample-service.json

ServiceArn=$(aws ecs describe-services --services ecs-sample-service --cluster ecs-sample-cluster \
    --query 'services[].serviceArn' --output text)
echo ${ServiceArn}
  # (e.g.) arn:aws:ecs:us-east-1:123456789012:service/ecs-sample-service
```

### 接続確認

```sh
curl -s ${DNSName}
```

### AWS CodeDeploy リソースを作成

```sh
aws deploy create-application \
    --application-name ecs-sample \
    --compute-platform ECS

aws elbv2 create-target-group \
    --name ecs-sample-tg2 \
    --protocol HTTP \
    --port 80 \
    --target-type ip \
    --vpc-id ${VpcId}

TargetGroup2Arn=$(aws elbv2 describe-target-groups --names ecs-sample-tg2 \
    --query 'TargetGroups[].TargetGroupArn' --output text)

cat <<EOT > ecs-sample-deployment-group.json
{
  "applicationName": "ecs-sample",
  "autoRollbackConfiguration": {
    "enabled": true,
    "events": [ "DEPLOYMENT_FAILURE" ]
  },
  "blueGreenDeploymentConfiguration": {
    "deploymentReadyOption": {
      "actionOnTimeout": "CONTINUE_DEPLOYMENT",
      "waitTimeInMinutes": 0
    },
    "terminateBlueInstancesOnDeploymentSuccess": {
      "action": "TERMINATE",
      "terminationWaitTimeInMinutes": 5
    }
  },
  "deploymentGroupName": "ecs-sample-deployment-group",
  "deploymentStyle": {
    "deploymentOption": "WITH_TRAFFIC_CONTROL",
    "deploymentType": "BLUE_GREEN"
  },
  "loadBalancerInfo": {
    "targetGroupPairInfoList": [
      {
        "targetGroups": [
          {
            "name": "ecs-sample-tg1"
          },
          {
            "name": "ecs-sample-tg2"
          }
        ],
        "prodTrafficRoute": {
          "listenerArns": [
            "${ListenerArn}"
          ]
        }
      }
    ]
  },
  "serviceRoleArn": "${EcsCodeDeployRoleArn}",
  "ecsServices": [
    {
      "serviceName": "ecs-sample-service",
      "clusterName": "ecs-sample-cluster"
    }
  ]
}
EOT

aws deploy create-deployment-group --cli-input-json file://ecs-sample-deployment-group.json

### デプロイ

appspec.yamlを配置するS3を作成

```sh
BucketName=ecs-sample-appspec-bucket
aws s3 mb s3://${BucketName}
```

appspec.yamlを作成

```sh
cat <<EOT > appspec.yaml
version: 0.0
Resources:
- TargetService:
    Type: AWS::ECS::Service
    Properties:
      TaskDefinition: ${TaskDefinitionArn}
      LoadBalancerInfo:
        ContainerName: web
        ContainerPort: 80
      PlatformVersion: LATEST
EOT

aws s3 cp appspec.yaml s3://${BucketName}/appspec.yaml
```

デプロイ

```sh
cat <<EOT > deployment.json
{
  "applicationName": "ecs-sample",
  "deploymentGroupName": "ecs-sample-deployment-group",
  "revision": {
    "revisionType": "S3",
    "s3Location": {
      "bucket": "${BucketName}",
      "key": "appspec.yaml",
      "bundleType": "YAML"
    }
  }
}
EOT

aws deploy create-deployment --cli-input-json file://deployment.json
```

### クリーンアップ

AWS CodeDeploy

```sh
aws deploy delete-deployment-group \
    --application-name ecs-sample \
    --deployment-group-name ecs-sample-deployment-group

aws deploy delete-application \
    --application-name ecs-sample
```

Amazon ECS

```sh
aws ecs delete-service \
    --cluster ecs-sample-cluster \
    --service ${ServiceArn} \
    --force

aws ecs delete-cluster \
    --cluster ecs-sample-cluster
```

Amazon S3

```sh
aws s3 rm s3://${BucketName}/appspec.yaml
aws s3 rb s3://${BucketName}
```

Elastic Load Balancing

```sh
aws elbv2 delete-load-balancer \
    --load-balancer-arn ${LoadBalancerArn}

aws elbv2 delete-target-group \
    --target-group-arn ${TargetGroup1Arn}

aws elbv2 delete-target-group \
    --target-group-arn ${TargetGroup2Arn}
```

Amazon ECR

```sh
aws ecr list-images --repository-name ecs-sample-web --query 'imageIds[].imageDigest' --output text | while read digest
do
  aws ecr batch-delete-image --repository-name ecs-sample-web --image-ids imageDigest=${digest}
done
aws ecr delete-repository --repository-name ecs-sample-web
```

```sh
aws ecr list-images --repository-name ecs-sample-app --query 'imageIds[].imageDigest' --output text | while read digest
do
  aws ecr batch-delete-image --repository-name ecs-sample-app --image-ids imageDigest=${digest}
done
aws ecr delete-repository --repository-name ecs-sample-app
```

Amazon CloudWatch Logs

```sh
aws logs delete-log-group --log-group-name /ecs/ecs-sample
```

AWS IAM

```sh
aws iam detach-role-policy --role-name ecsSampleTaskExecutionRole \
    --policy-arn "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
aws iam delete-role --role-name ecsSampleTaskExecutionRole
```

```sh
aws iam detach-role-policy --role-name ecsSampleCodeDeployRole \
    --policy-arn "arn:aws:iam::aws:policy/AWSCodeDeployRoleForECS"
aws iam delete-role --role-name ecsSampleCodeDeployRole
```
