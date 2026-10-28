variable "aws_region" {
  description = "AWS region. Must be the AWS project's selected Region (eu-north-1, Stockholm)."
  type        = string
  default     = "eu-north-1"
}

variable "project" {
  description = "Name prefix for every resource."
  type        = string
  default     = "commuteer"
}

variable "alert_email" {
  description = "Email address for alarms and budget warnings. AWS sends a confirmation link first."
  type        = string
}

variable "monthly_budget_usd" {
  description = "Monthly AWS spend that triggers a budget email (at 80% actual and 100% forecast)."
  type        = number
  default     = 10
}

variable "log_retention_days" {
  description = "How long Lambda logs are kept."
  type        = number
  default     = 30
}
