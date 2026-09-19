# 1. Project Purpose

This project contains the backend API for the Jewelry Showcase ecosystem.

It provides a secure API layer between:

```text
Admin Portal
      ↓
Backend API
      ↓
AWS S3
      ↓
Mobile Application
```

The backend is responsible for:

* Reading application data
* Writing application data
* Managing S3 objects
* Managing product images
* Managing category data
* Managing company metadata
* Managing services
* Serving customer-facing APIs
* Serving admin APIs
* Authentication
* Authorization
* Validation
* Logging
* Error handling

---

# 2. Technology

Preferred architecture:

```text
AWS Lambda
    +
Express.js
    +
AWS SDK
    +
Amazon S3
```

The backend should be designed as a serverless application.

Do not introduce always-running servers unless explicitly required.

---

# 3. AWS Architecture

Initial storage architecture:

```text
                    AWS
                     │
                     ▼
              ┌─────────────┐
              │     S3      │
              └──────┬──────┘
                     │
          ┌──────────┼──────────┐
          ▼          ▼          ▼
      Products   Categories   Company
         JSON        JSON       JSON
          │
          ▼
       Images
```

Potential S3 structure:

```text
bucket/
│
├── data/
│   ├── products/
│   │   ├── rings.json
│   │   ├── necklaces.json
│   │   ├── earrings.json
│   │   └── ...
│   │
│   ├── categories.json
│   ├── company.json
│   ├── services.json
│   └── home.json
│
└── media/
    ├── products/
    │   ├── rings/
    │   ├── necklaces/
    │   ├── earrings/
    │   └── ...
    │
    ├── categories/
    ├── company/
    ├── services/
    └── home/
```

The exact bucket structure can evolve.

The API must hide the S3 implementation from clients.

---

# 4. Important Storage Principle

S3 is the storage implementation.

The API is the public contract.

Clients must NOT depend directly on:

* S3 bucket name
* S3 object keys
* JSON file names
* Internal S3 folder structure

The architecture must allow S3 storage to be replaced in the future without breaking the mobile application.

---

# 5. Data Ownership

Backend owns the following data:

```text
Products
Categories
Company Metadata
Services
Home Page Content
Media
```

Admin Portal writes this data through backend APIs.

Mobile App reads this data through backend APIs.

---

# 6. Product Storage

The initial plan is to maintain product data category-wise.

Example:

```text
data/products/rings.json
data/products/necklaces.json
data/products/earrings.json
```

Example:

```json
{
  "categoryId": "rings",
  "products": [
    {
      "id": "ring-001",
      "name": "Classic Diamond Ring",
      "description": "Premium diamond ring",
      "price": 125000,
      "currency": "INR",
      "material": "Gold",
      "purity": "18K",
      "weight": "4.5g",
      "images": [],
      "active": true
    }
  ]
}
```

The exact schema should be defined and versioned before production.

---

# 7. Stable IDs

Every:

* Product
* Category
* Service

must have a stable unique ID.

Never use display names as permanent identifiers.

Example:

GOOD:

```text
categoryId = "rings"
```

Potentially problematic:

```text
categoryId = "Gold Rings"
```

because the display name may change.

---

# 8. Company Metadata

Maintain a separate company metadata object.

Example:

```json
{
  "companyName": "Example Jewellers",
  "logoUrl": "https://...",
  "phone": "+91...",
  "email": "info@example.com",
  "website": "https://...",
  "address": {
    "line1": "...",
    "city": "...",
    "state": "...",
    "country": "India",
    "postalCode": "..."
  },
  "socialLinks": {
    "instagram": "...",
    "facebook": "...",
    "whatsapp": "..."
  }
}
```

The exact fields should remain extensible.

The mobile app should consume:

```text
GET /api/company
```

---

# 9. Categories

Category data should include enough information for both Admin and Mobile clients.

Example:

```json
{
  "id": "rings",
  "name": "Rings",
  "description": "Explore our ring collection",
  "imageUrl": "https://...",
  "displayOrder": 1,
  "active": true
}
```

---

# 10. Services

Example:

```json
{
  "id": "custom-jewelry",
  "name": "Custom Jewelry",
  "description": "Create a personalized jewelry piece.",
  "imageUrl": "https://...",
  "displayOrder": 1,
  "active": true
}
```

---

# 11. API Design

Separate public/customer APIs from admin APIs.

Example:

## Public

```text
GET /api/company
GET /api/categories
GET /api/categories/:categoryId/products
GET /api/products/:productId
GET /api/services
GET /api/home
```

## Admin

```text
POST   /api/admin/products
PUT    /api/admin/products/:id
DELETE /api/admin/products/:id

POST   /api/admin/categories
PUT    /api/admin/categories/:id
DELETE /api/admin/categories/:id

GET    /api/admin/company
PUT    /api/admin/company

POST   /api/admin/media
DELETE /api/admin/media/:id
```

Exact routes may evolve.

Do not expose admin endpoints without authentication and authorization.

---

# 12. API Response Consistency

Use consistent response structures.

Example success:

```json
{
  "success": true,
  "data": {}
}
```

Example error:

```json
{
  "success": false,
  "error": {
    "code": "PRODUCT_NOT_FOUND",
    "message": "Product not found"
  }
}
```

Do not expose internal stack traces.

---

# 13. S3 Access

Use the official AWS SDK.

The Lambda execution role should provide required S3 permissions.

Do not use static AWS access keys inside application code.

The AWS SDK should use the Lambda execution role / configured AWS credentials.

---

# 14. AWS Credentials

NEVER hardcode:

```text
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
```

The CLI/environment is already configured for AWS administration.

Use IAM roles and least-privilege permissions for deployed Lambda resources.

Administrative AWS access from the developer CLI does NOT mean the Lambda function should have unrestricted AWS access.

---

# 15. IAM Principle

Follow least privilege.

The Lambda execution role should only have access to the required:

* S3 bucket
* S3 prefixes
* CloudWatch logging
* Other AWS services actually used

Do not automatically grant:

```text
AdministratorAccess
```

to Lambda.

---

# 16. Image Upload Architecture

Preferred flow:

```text
Admin Portal
      │
      │ Request upload
      ▼
Backend
      │
      │ Generate secure upload URL
      ▼
Admin Portal
      │
      │ Upload image
      ▼
S3
```

Alternatively, the backend can receive and upload the file if the implementation requires it.

Prefer pre-signed uploads for larger files when practical.

The browser must never receive permanent AWS credentials.

---

# 17. Image Storage

Recommended:

```text
media/products/{categoryId}/{productId}/{imageId}.webp
```

or equivalent stable structure.

Do not use filenames supplied by users as trusted object keys.

Sanitize and generate safe object names.

---

# 18. Image Validation

Validate:

* MIME type
* File extension
* File size
* Image dimensions where appropriate

Do not trust only the client-side validation.

The backend must validate uploads.

---

# 19. Product Update Transaction

When updating a product:

```text
Validate request
      ↓
Validate category
      ↓
Validate product data
      ↓
Upload/validate media if required
      ↓
Update product JSON
      ↓
Return updated product
```

If an operation partially fails, the backend should avoid leaving inconsistent metadata where possible.

---

# 20. JSON Concurrency Problem

S3 JSON files are not databases.

If two administrators update the same JSON file at approximately the same time, a simple:

```text
GET JSON
modify JSON
PUT JSON
```

can cause a lost update.

The backend MUST consider concurrency.

Possible solutions include:

* S3 ETag / conditional writes
* Version identifiers
* Optimistic locking
* Centralized update serialization
* Migration to DynamoDB when scale requires it

Do not ignore this issue.

For the initial implementation, use an explicit concurrency strategy rather than silently overwriting changes.

---

# 21. Data Validation

Validate all incoming data on the backend.

Examples:

Product:

```text
id
name
categoryId
price
currency
description
images
active
```

Company:

```text
companyName
phone
email
address
logoUrl
```

Category:

```text
id
name
imageUrl
displayOrder
active
```

Never trust Admin Portal validation alone.

---

# 22. Authentication

Admin endpoints must require authentication.

Public product APIs may remain public if appropriate.

Admin authentication should be implemented using a proper identity/authentication mechanism.

The exact provider may be:

* Amazon Cognito
* Another approved identity provider

Do not build insecure custom password authentication without a strong reason.

---

# 23. Authorization

Authentication answers:

```text
Who are you?
```

Authorization answers:

```text
Are you allowed to do this?
```

Both are required.

Admin endpoints must verify authorization server-side.

---

# 24. Public API Security

Public APIs should:

* Validate query parameters
* Validate IDs
* Limit response size
* Support pagination where required
* Avoid exposing internal S3 details
* Avoid exposing secrets
* Apply rate limiting/throttling where appropriate

---

# 25. Caching

Because product/category/company data may change relatively infrequently, caching can be considered.

Potential approaches:

* API caching
* CloudFront
* Application-level caching

Do not add unnecessary infrastructure during the initial implementation.

Design APIs so caching can be introduced later.

---

# 26. CDN / Images

S3 can store images, but public image delivery should be designed carefully.

Consider:

```text
S3
 ↓
CloudFront
 ↓
Mobile App
```

rather than exposing the entire S3 bucket directly.

Do not make the S3 bucket publicly writable.

---

# 27. S3 Security

Never make the entire S3 bucket publicly writable.

Prefer:

```text
Admin
 ↓
Backend / Presigned URL
 ↓
S3
```

Customer image access may be public/read-only through an appropriate delivery mechanism.

---

# 28. Environment Configuration

Use separate environments:

```text
Development
Staging
Production
```

Each environment should have:

* Separate configuration
* Appropriate S3 bucket/prefix
* Appropriate Lambda configuration

Avoid accidentally modifying production data during development.

---

# 29. AWS Deployment

The backend should be deployable using infrastructure-as-code where practical.

Possible options:

* AWS SAM
* AWS CDK
* Serverless Framework
* Terraform

Choose one approach and remain consistent.

Do not manually configure production infrastructure repeatedly if it can be codified.

---

# 30. Logging

Use structured logging.

Log:

* Request ID
* Operation
* Success/failure
* Useful diagnostic information

Do NOT log:

* Passwords
* Access tokens
* AWS secrets
* Payment information
* Sensitive customer information

Use CloudWatch for Lambda logs.

---

# 31. Error Handling

Centralize Express error handling.

Return customer-safe/admin-safe messages.

Example:

```json
{
  "success": false,
  "error": {
    "code": "INVALID_PRODUCT",
    "message": "The product information is invalid."
  }
}
```

Do not return:

```text
Error: Cannot read property 'x' of undefined
```

to clients.

---

# 32. API Versioning

Design the API so breaking changes can be introduced safely.

Potential structure:

```text
/api/v1/...
```

If versioning is adopted, use it consistently.

Do not introduce breaking changes to production clients without planning migration.

---

# 33. Mobile Compatibility

The mobile application is a consumer of the backend API.

Therefore:

Before changing any response field:

Check:

```text
Mobile App
Admin Portal
Backend
S3 data
```

Avoid removing fields that existing app versions depend on.

Prefer additive changes.

---

# 34. Admin Compatibility

The Admin Portal is also a consumer of backend APIs.

Backend changes must preserve the Admin Portal contract unless coordinated.

---

# 35. Schema Evolution

When adding a new field:

Prefer:

```text
new optional field
```

rather than making an existing field mandatory immediately.

Example:

```json
{
  "product": "...",
  "certificateUrl": "..."
}
```

Older products may not contain `certificateUrl`.

The mobile app must handle missing optional fields gracefully.

---

# 36. Data Migration

If the S3 JSON schema changes:

Create a migration strategy.

Do not manually edit large production JSON files without understanding:

* Existing records
* References
* IDs
* Images
* Consumers

---

# 37. Testing

Backend tests should cover:

### Products

* Create
* Read
* Update
* Delete/deactivate
* Invalid product
* Missing category
* Duplicate ID

### Categories

* Create
* Read
* Update
* Delete/deactivate

### Company

* Read
* Update
* Logo update

### Media

* Upload
* Validation
* Delete
* Invalid file

### Authentication

* Unauthorized request
* Authorized request
* Forbidden request

### S3

* Read
* Write
* Failure
* Concurrency handling

---

# 38. API Contract Testing

The backend should have tests ensuring responses remain compatible with:

* Mobile App
* Admin Portal

When possible, define schemas/types centrally.

---

# 39. Type Safety

Use TypeScript where practical.

Create shared domain types such as:

```text
Product
Category
CompanyMetadata
Service
HomeContent
```

Do not use `any` unnecessarily.

---

# 40. Recommended Backend Structure

Example:

```text
src/
│
├── handlers/
│
├── routes/
│   ├── public/
│   └── admin/
│
├── controllers/
│
├── services/
│   ├── products/
│   ├── categories/
│   ├── company/
│   ├── services/
│   ├── media/
│   └── storage/
│
├── repositories/
│   └── s3/
│
├── middleware/
│   ├── auth/
│   ├── validation/
│   └── error/
│
├── models/
│
├── schemas/
│
├── utils/
│
├── config/
│
└── types/
```

The exact structure can be adapted to the existing project.

---

# 41. Storage Abstraction

Do not put S3 calls directly inside controllers.

Prefer:

```text
Controller
    ↓
Service
    ↓
Repository
    ↓
S3
```

Example:

```text
ProductController
      ↓
ProductService
      ↓
ProductRepository
      ↓
S3Repository
```

This makes future migration easier.

---

# 42. Important Rule

The following is BAD:

```typescript
app.get('/products', async (req, res) => {
   // 200 lines of S3 logic
});
```

Prefer:

```typescript
app.get('/products', productController.list);
```

with storage logic separated.

---

# 43. AWS CLI Usage

The developer environment may have AWS CLI credentials configured.

Claude Code may inspect AWS resources when explicitly required.

Before making AWS changes:

1. Identify the AWS account.
2. Identify the environment.
3. Identify the resource.
4. Explain the intended change.
5. Verify the target.
6. Make the smallest required change.
7. Verify the result.

NEVER assume a resource is development just because its name looks like development.

---

# 44. Production Safety

Production data is valuable.

Before destructive AWS operations:

* Confirm environment
* Confirm resource
* Confirm target object
* Prefer backup/versioning
* Avoid bulk deletion unless explicitly requested

Do not delete an S3 bucket, Lambda, IAM role, or production data without explicit instruction.

---

# 45. S3 Versioning

Consider enabling S3 versioning for production data where appropriate.

This provides additional protection against accidental overwrites/deletions.

Do not assume versioning exists; verify the actual environment.

---

# 46. Backup Strategy

Production JSON data should have a recovery strategy.

Possible options:

* S3 versioning
* Backup bucket
* Scheduled snapshots
* Cross-region backup where justified

Do not build an unnecessarily complex backup system initially.

---

# 47. Cost Awareness

The architecture should remain cost-efficient.

Avoid unnecessary:

* Lambda invocations
* S3 requests
* Large payloads
* Excessive CloudWatch logs
* Unnecessary AWS services

Optimize only where it provides meaningful value.

---

# 48. API Performance

Public APIs should avoid repeatedly downloading the same large JSON object from S3 for every request.

Possible future improvements:

```text
Lambda
  ↓
Cache
  ↓
S3
```

or:

```text
CloudFront
```

or eventually:

```text
DynamoDB
```

Start simple, but keep the architecture extensible.

---

# 49. Future Database Migration

S3 JSON is acceptable for the initial catalog/content-management architecture if the dataset and write concurrency remain manageable.

However, do not design the application so that S3 JSON becomes permanently embedded into business logic.

The repository abstraction should allow future migration to:

```text
DynamoDB
RDS
Aurora
Other database
```

without rewriting controllers and API contracts.

---

# 50. Cross-Project Contract

These three projects are one system:

```text
┌────────────────────┐
│    Admin Portal    │
└─────────┬──────────┘
          │
          │ Admin API
          ▼
┌────────────────────┐
│   Backend API      │
│ Lambda + Express   │
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│       S3           │
│ JSON + Media       │
└─────────┬──────────┘
          │
          │ Public API
          ▼
┌────────────────────┐
│    Mobile App      │
└────────────────────┘
```

Any change to a shared data model must consider all three projects.

---

# 51. Change Protocol

When changing a shared model:

```text
1. Identify current schema.
2. Identify Admin Portal consumers.
3. Identify Mobile App consumers.
4. Identify S3 data.
5. Design backward-compatible change.
6. Update backend.
7. Update Admin Portal if required.
8. Update Mobile App if required.
9. Test end-to-end.
```

Do not make isolated breaking changes.

---

# 52. Claude Code AWS Rules

Because this project has AWS access:

### Read operations

Claude may inspect AWS resources when required for the task.

Examples:

* S3 bucket configuration
* S3 objects
* Lambda configuration
* CloudWatch logs
* IAM configuration
* API Gateway configuration

### Write operations

Before making AWS changes:

Explain:

```text
AWS Account:
Environment:
Resource:
Current state:
Requested change:
Risk:
Expected result:
```

Then make the change.

### Destructive operations

Never perform destructive production operations without explicit user approval.

Examples:

* Delete S3 bucket
* Delete production objects
* Delete Lambda
* Delete IAM role
* Remove production infrastructure
* Disable security controls

---

# 53. Secrets

Never expose or commit:

* AWS secret keys
* API keys
* JWT secrets
* Passwords
* Payment secrets
* Database credentials

If a secret appears in logs or command output, do not copy it into source code or documentation.

---

# 54. Final Principle

The backend is the **contract and security boundary** of the entire system.

The Admin Portal manages content.

S3 stores content.

The Mobile App consumes content.

The backend controls access between them.

Keep these responsibilities separate.

The long-term architecture should allow:

```text
Admin Portal
      ↓
Stable API
      ↓
Any storage implementation
      ↓
Stable API
      ↓
Mobile App
```

The mobile application and Admin Portal should not need to know whether the backend stores data in S3, DynamoDB, RDS, or another system.

---

# 55. Claude Code Final Rules

Before implementing:

1. Read existing code.
2. Inspect AWS resources when relevant.
3. Understand the data model.
4. Check Admin/Mobile compatibility.
5. Identify affected APIs.
6. Identify S3 changes.
7. Explain the plan.
8. Implement the smallest safe change.
9. Test.
10. Verify AWS changes where applicable.

Never make assumptions about production infrastructure.

Never expose secrets.

Never bypass authentication.

Never make destructive AWS changes without explicit approval.
