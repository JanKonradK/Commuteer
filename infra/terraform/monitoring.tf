resource "aws_sns_topic" "alerts" {
  name = "${var.project}-alerts"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

locals {
  alarm_actions = [aws_sns_topic.alerts.arn]
  poller_name   = aws_lambda_function.collector["poller"].function_name
}

# The poller stopped running at all (schedule disabled, deploy broke it, account issue).
resource "aws_cloudwatch_metric_alarm" "poller_silent" {
  alarm_name          = "${var.project}-poller-silent"
  alarm_description   = "No poller invocations for 10 minutes: data collection has stopped."
  namespace           = "AWS/Lambda"
  metric_name         = "Invocations"
  dimensions          = { FunctionName = local.poller_name }
  statistic           = "Sum"
  period              = 600
  evaluation_periods  = 1
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# Every source failed in several windows (the function raises in that case).
resource "aws_cloudwatch_metric_alarm" "poller_errors" {
  alarm_name          = "${var.project}-poller-errors"
  alarm_description   = "The poller failed completely in 3+ windows within 10 minutes."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = local.poller_name }
  statistic           = "Sum"
  period              = 600
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 3
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# One feed keeps failing while others work (e.g. NTA key expired, Irish Rail down).
resource "aws_cloudwatch_log_metric_filter" "poll_errors" {
  name           = "${var.project}-poll-errors"
  log_group_name = aws_cloudwatch_log_group.collector["poller"].name
  pattern        = "{ $.event = \"poll_error\" }"

  metric_transformation {
    name          = "PollErrors"
    namespace     = var.project
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "feed_failing" {
  alarm_name          = "${var.project}-feed-failing"
  alarm_description   = "A realtime feed has failed 15+ times in 15 minutes."
  namespace           = var.project
  metric_name         = "PollErrors"
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 15
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "nightly_job_failed" {
  for_each = toset(["rail_movements", "gtfs_snapshot", "bus_history"])

  alarm_name          = "${var.project}-${each.key}-failed"
  alarm_description   = "The ${each.key} job failed (after retries)."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.collector[each.key].function_name }
  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

resource "aws_budgets_budget" "monthly" {
  name         = "${var.project}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}
