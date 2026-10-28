output "data_bucket" {
  value = aws_s3_bucket.data.bucket
}

output "nta_api_key_parameter" {
  value = aws_ssm_parameter.nta_api_key.name
}

output "functions" {
  value = { for k, f in aws_lambda_function.collector : k => f.function_name }
}

output "bus_live_url" {
  value = aws_lambda_function_url.bus_live.function_url
}
