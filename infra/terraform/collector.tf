locals {
  # Each collector job: handler, how often it runs, and how much it needs.
  functions = {
    poller = {
      handler     = "commuteer.collector.handlers.poll"
      schedule    = "rate(1 minute)"
      timeout     = 75
      memory      = 256
      ephemeral   = 512
      description = "Polls realtime feeds every 30-60 s within a 1-minute window"
    }
    rail_movements = {
      handler     = "commuteer.collector.handlers.rail_movements"
      schedule    = "cron(30 2 * * ? *)"
      timeout     = 900
      memory      = 256
      ephemeral   = 512
      description = "Nightly: stop-by-stop actual times for every train that ran yesterday"
    }
    gtfs_snapshot = {
      handler     = "commuteer.collector.handlers.gtfs_snapshot"
      schedule    = "cron(0 5 * * ? *)"
      timeout     = 600
      memory      = 512
      ephemeral   = 1024 # the national timetable zip is ~200 MB
      description = "Daily: store the national GTFS timetable if it changed"
    }
  }
}

data "archive_file" "collector" {
  type        = "zip"
  source_dir  = "${path.module}/../../src"
  output_path = "${path.module}/build/collector.zip"
  excludes    = ["**/__pycache__/**", "**/*.pyc"]
}

# --- IAM: what the functions may do ---------------------------------------------------------

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "collector" {
  name               = "${var.project}-collector"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "collector" {
  statement {
    sid     = "WriteRawData"
    actions = ["s3:PutObject", "s3:GetObject"]
    resources = [
      "${aws_s3_bucket.data.arn}/bronze/*",
      "${aws_s3_bucket.data.arn}/latest/*", # newest snapshot of each feed, read by bus_live
    ]
  }
  statement {
    sid       = "ListRawData"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.data.arn]
  }
  statement {
    sid       = "ReadApiKey"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.nta_api_key.arn]
  }
  statement {
    sid     = "WriteLogs"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = concat(
      [for lg in aws_cloudwatch_log_group.collector : "${lg.arn}:*"],
      ["${aws_cloudwatch_log_group.bus_live.arn}:*"],
    )
  }
}

resource "aws_iam_role_policy" "collector" {
  role   = aws_iam_role.collector.id
  policy = data.aws_iam_policy_document.collector.json
}

# --- Functions ------------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "collector" {
  for_each          = local.functions
  name              = "/aws/lambda/${var.project}-${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "collector" {
  for_each = local.functions

  function_name    = "${var.project}-${each.key}"
  description      = each.value.description
  role             = aws_iam_role.collector.arn
  runtime          = "python3.12"
  architectures    = ["arm64"] # Graviton: ~20% cheaper per second
  handler          = each.value.handler
  filename         = data.archive_file.collector.output_path
  source_code_hash = data.archive_file.collector.output_base64sha256
  timeout          = each.value.timeout
  memory_size      = each.value.memory

  ephemeral_storage {
    size = each.value.ephemeral
  }

  environment {
    variables = {
      DATA_BUCKET       = aws_s3_bucket.data.bucket
      NTA_API_KEY_PARAM = aws_ssm_parameter.nta_api_key.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.collector, aws_iam_role_policy.collector]
}

# --- Schedules (EventBridge Scheduler, in Irish local time) ---------------------------------

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${var.project}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

resource "aws_iam_role_policy" "scheduler" {
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = [for f in aws_lambda_function.collector : f.arn]
    }]
  })
}

resource "aws_scheduler_schedule" "collector" {
  for_each = local.functions

  name                         = "${var.project}-${each.key}"
  schedule_expression          = each.value.schedule
  schedule_expression_timezone = "Europe/Dublin"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.collector[each.key].arn
    role_arn = aws_iam_role.scheduler.arn

    retry_policy {
      # A retried poll would just be a stale duplicate; the nightly jobs are worth retrying.
      maximum_retry_attempts = each.key == "poller" ? 0 : 2
    }
  }
}
