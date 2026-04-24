# Prepare A Standard Agent Setup in Local Machine

Requirements: 

1. Extend the nanoclaw for a agent to agent communication tool. What will be the communication medium?
2. Agents should be configurable by skills and models. Prepare a folder structure where we can configure agents by skills. Also we should be able to configure the model for the agents.
  - initially there will be 4 agents: backend engineer, data streaming engineer, data lake engineer and devops engineer. data streaming engineer will be skilled with flink streaming, should have knowledge over our franz-data-streaming, datalake-integration and franz-glue-catalog gitops project. data lake engineer should be skilled with AWS Athena, Apache Iceberg and should have knowledge over our franz-glue-catalog-gitops and datalake-model-gitops project. backend engineer should be skilled with kotlin-java-spring boot stack and should have knowledge over data api service. devops engineer should know terraform, aws services and should have knowledge over terraform-clm project
3. Build a task orchestrator design to delegate the task to specialised agent.
4. For cross collabotation there should be a communication layer between them with persistent memory and rating system for self evolution.
5. Build a dashboard to monitor their tasks.

