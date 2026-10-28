# Live bus delays for the phone app: a public Lambda function URL that reads the
# newest feed snapshot the poller saved to S3. Phones never see the TFI API key,
# and TFI gets no extra traffic however many people use the app.

resource "aws_cloudwatch_log_group" "bus_live" {
  name              = "/aws/lambda/${var.project}-bus_live"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "bus_live" {
  function_name    = "${var.project}-bus_live"
  description      = "GET ?trips=ID,... -> live delays for those bus trips"
  role             = aws_iam_role.collector.arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "commuteer.collector.handlers.bus_live"
  filename         = data.archive_file.collector.output_path
  source_code_hash = data.archive_file.collector.output_base64sha256
  timeout          = 10
  memory_size      = 512 # decoding the ~3,500-trip feed is CPU-bound; more memory = more CPU

  environment {
    variables = {
      DATA_BUCKET = aws_s3_bucket.data.bucket
    }
  }

  depends_on = [aws_cloudwatch_log_group.bus_live, aws_iam_role_policy.collector]
}

resource "aws_lambda_function_url" "bus_live" {
  function_name      = aws_lambda_function.bus_live.function_name
  authorization_type = "NONE" # read-only public transport data

  cors {
    allow_origins = ["*"]
    allow_methods = ["GET"]
    max_age       = 3600
  }
}

resource "aws_cloudwatch_metric_alarm" "bus_live_errors" {
  alarm_name          = "${var.project}-bus-live-errors"
  alarm_description   = "The live bus API is failing."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.bus_live.function_name }
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 5
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}
