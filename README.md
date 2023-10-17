## emr-on-eks-with-cdk

- ja: [CDK で EKS クラスタを立ち上げ EMR on EKS に登録し Spark のジョブを動かす - sambaiz-net](https://www.sambaiz.net/article/434/)
- en: [Launch an EKS cluster and register it to EMR on EKS with CDK to run Spark jobs - sambaiz-net](https://www.sambaiz.net/en/article/434/)

### Launch an EKS cluster and register it to EMR

```sh
$ npm run build
$ npm run cdk deploy
$ export VIRTUAL_CLUSTER_ID=xxxx EXECUTION_ROLE_ARN=xxxx
```

### Run a test job

```sh
$ aws s3 cp s3://aws-data-analytics-workshops/emr-eks-workshop/scripts/pi.py s3://<mybucket>/pi.py
$ aws emr-containers start-job-run \
  --virtual-cluster-id $VIRTUAL_CLUSTER_ID \
  --name pi-2 \
  --execution-role-arn $EXECUTION_ROLE_ARN \
  --release-label emr-6.13.0-latest \
  --job-driver '{
      "sparkSubmitJobDriver": {
          "entryPoint": "s3://<mybucket>/pi.py",
          "sparkSubmitParameters": "--conf spark.executor.instances=1 --conf spark.executor.memory=2G --conf spark.executor.cores=1 --conf spark.driver.cores=1"
      }
  }'
  
$ kubectl get pod -n emrcontainers
NAME                               READY   STATUS    RESTARTS   AGE
000000032psj6spu6q7-5qpsg          2/2     Running   0          28s
pythonpi-4b35838b3c9a1810-exec-1   1/1     Running   0          3s
spark-000000032psj6spu6q7-driver   2/2     Running   0          17s
```
