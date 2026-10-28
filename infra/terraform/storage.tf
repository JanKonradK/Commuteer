resource "aws_s3_bucket" "data" {
  bucket = "${var.project}-data-${data.aws_caller_identity.current.account_id}-${var.aws_region}"
}

resource "aws_s3_bucket_public_access_block" "data" {
  bucket                  = aws_s3_bucket.data.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "data" {
  bucket = aws_s3_bucket.data.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  bucket = aws_s3_bucket.data.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Raw snapshots are tiny (a few KB), so moving them to Infrequent Access would cost
# more, not less (it bills a 128 KB minimum per object). The plan is to compact them
# into daily Parquet files in a later milestone and expire the raw files after that.
resource "aws_s3_bucket_lifecycle_configuration" "data" {
  bucket = aws_s3_bucket.data.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 2
    }
  }
}

# The NTA key is set outside Terraform so it never lands in state or git:
#   aws ssm put-parameter --name /commuteer/nta_api_key --type SecureString --overwrite --value <key>
resource "aws_ssm_parameter" "nta_api_key" {
  name        = "/${var.project}/nta_api_key"
  description = "Transport for Ireland GTFS-Realtime API key"
  type        = "SecureString"
  value       = "CHANGE_ME"

  lifecycle {
    ignore_changes = [value]
  }
}
