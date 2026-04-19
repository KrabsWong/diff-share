#!/bin/bash

# Diff Share Deployment Script
# This script will guide you through deploying diff-share to Cloudflare

set -e  # Exit on error

echo "=================================="
echo "Diff Share - Deployment Script"
echo "=================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running from correct directory
if [ ! -d "packages/worker" ]; then
    echo -e "${RED}Error: Please run this script from the diff-share root directory${NC}"
    exit 1
fi

# Check if wrangler.toml exists, if not copy from example
if [ ! -f "packages/worker/wrangler.toml" ]; then
    if [ -f "packages/worker/wrangler.toml.example" ]; then
        echo "Creating wrangler.toml from template..."
        cp packages/worker/wrangler.toml.example packages/worker/wrangler.toml
        echo -e "${GREEN}✓ Created wrangler.toml from template${NC}"
    else
        echo -e "${RED}Error: Neither wrangler.toml nor wrangler.toml.example found${NC}"
        exit 1
    fi
fi
echo ""

# Check dependencies
echo "Step 1: Checking dependencies..."
if ! command -v wrangler &> /dev/null; then
    echo "Installing wrangler..."
    npm install -g wrangler
fi

if ! command -v bun &> /dev/null; then
    echo -e "${RED}Error: Bun is not installed. Please install it first:${NC}"
    echo "curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

echo -e "${GREEN}✓ Dependencies OK${NC}"
echo ""

# Install project dependencies
echo "Step 2: Installing project dependencies..."
bun install
echo -e "${GREEN}✓ Dependencies installed${NC}"
echo ""

# Check if already logged in
echo "Step 3: Checking Cloudflare authentication..."
WRANGLER_WHOAMI=$(wrangler whoami 2>&1 || true)

if echo "$WRANGLER_WHOAMI" | grep -q "Not logged in"; then
    echo "Not logged in. Please login to Cloudflare..."
    wrangler login
else
    echo -e "${GREEN}✓ Already logged in${NC}"
fi
echo ""

# Get account info
echo "Step 4: Getting account information..."
ACCOUNT_INFO=$(wrangler whoami 2>/dev/null || echo "")
echo -e "${GREEN}✓ Account info retrieved${NC}"
echo ""

cd packages/worker

# Check if D1 database already exists
echo "Step 5: Creating D1 database..."
if ! wrangler d1 list 2>/dev/null | grep -q "diff-share-db"; then
    echo "Creating D1 database 'diff-share-db'..."
    wrangler d1 create diff-share-db 2>&1 | tee /tmp/d1_output.txt
    
    # Extract database ID
    DATABASE_ID=$(grep -oP 'database_id: "\K[^"]+' /tmp/d1_output.txt || echo "")
    
    if [ -z "$DATABASE_ID" ]; then
        # Try alternative extraction
        DATABASE_ID=$(grep -oP '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' /tmp/d1_output.txt | head -1 || echo "")
    fi
    
    if [ -n "$DATABASE_ID" ]; then
        echo "Database ID: $DATABASE_ID"
        
        # Update wrangler.toml
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS
            sed -i '' "s/database_id = \"\"/database_id = \"$DATABASE_ID\"/" wrangler.toml
        else
            # Linux
            sed -i "s/database_id = \"\"/database_id = \"$DATABASE_ID\"/" wrangler.toml
        fi
        echo -e "${GREEN}✓ Updated wrangler.toml with database ID${NC}"
    else
        echo -e "${YELLOW}⚠ Could not automatically extract database ID${NC}"
        echo "Please manually update wrangler.toml with the database_id shown above"
        read -p "Press Enter after updating wrangler.toml..."
    fi
else
    echo -e "${YELLOW}Database 'diff-share-db' already exists${NC}"
    echo "If you need to recreate it, delete it first from Cloudflare Dashboard"
fi
echo ""

# Create R2 bucket
echo "Step 6: Creating R2 bucket..."
if ! wrangler r2 bucket list 2>/dev/null | grep -q "diff-share-files"; then
    echo "Creating R2 bucket 'diff-share-files'..."
    wrangler r2 bucket create diff-share-files
    echo -e "${GREEN}✓ R2 bucket created${NC}"
else
    echo -e "${YELLOW}Bucket 'diff-share-files' already exists${NC}"
fi
echo ""

# Get R2 public URL
echo "Step 7: Getting R2 public URL..."
echo "Checking R2 bucket public access..."
R2_INFO=$(wrangler r2 bucket info diff-share-files 2>&1 || echo "")

# Try to extract R2 dev URL
R2_URL=$(echo "$R2_INFO" | grep -oP 'https://pub-[a-zA-Z0-9]+\.r2\.dev' | head -1 || echo "")

if [ -z "$R2_URL" ]; then
    echo -e "${YELLOW}⚠ Could not automatically detect R2 public URL${NC}"
    echo "Please enable R2.dev subdomain in Cloudflare Dashboard:"
    echo "  1. Go to Cloudflare Dashboard → R2"
    echo "  2. Click on 'diff-share-files' bucket"
    echo "  3. Go to Settings tab"
    echo "  4. Enable 'R2.dev subdomain'"
    echo ""
    read -p "Enter your R2 public URL (e.g., https://pub-xxx.r2.dev): " R2_URL
fi

if [ -n "$R2_URL" ]; then
    # Update wrangler.toml
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|R2_PUBLIC_URL = \"https://pub-xxxxxxxx.r2.dev\"|R2_PUBLIC_URL = \"$R2_URL\"|" wrangler.toml
    else
        sed -i "s|R2_PUBLIC_URL = \"https://pub-xxxxxxxx.r2.dev\"|R2_PUBLIC_URL = \"$R2_URL\"|" wrangler.toml
    fi
    echo -e "${GREEN}✓ Updated wrangler.toml with R2 URL: $R2_URL${NC}"
else
    echo -e "${RED}✗ R2 URL not configured. Deployment may fail.${NC}"
fi
echo ""

# Initialize database schema
echo "Step 8: Initializing database schema..."
wrangler d1 execute diff-share-db --file=./schema.sql
echo -e "${GREEN}✓ Database schema initialized${NC}"
echo ""

# Deploy Worker
echo "Step 9: Deploying Worker..."
DEPLOY_OUTPUT=$(wrangler deploy 2>&1)
echo "$DEPLOY_OUTPUT"

# Extract Worker URL
WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -oP 'https://[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.workers\.dev' | head -1 || echo "")

if [ -n "$WORKER_URL" ]; then
    echo ""
    echo -e "${GREEN}✓ Worker deployed successfully!${NC}"
    echo "Worker URL: $WORKER_URL"
else
    echo ""
    echo -e "${YELLOW}⚠ Could not extract Worker URL from output${NC}"
    WORKER_URL="https://diff-share-worker.<your-account>.workers.dev"
fi
echo ""

# Build CLI
echo "Step 10: Building CLI..."
cd ../cli
bun run build
echo -e "${GREEN}✓ CLI built successfully${NC}"
echo ""

# Summary
echo "=================================="
echo -e "${GREEN}Deployment Complete!${NC}"
echo "=================================="
echo ""
echo "Configuration Summary:"
echo "----------------------"
echo "Worker URL: $WORKER_URL"
echo "R2 Public URL: $R2_URL"
echo ""
echo "Next Steps:"
echo "-----------"
echo "1. Set environment variable for CLI:"
echo "   export DIFF_SHARE_API_URL=$WORKER_URL"
echo ""
echo "2. Or add to your ~/.bashrc or ~/.zshrc:"
echo "   echo 'export DIFF_SHARE_API_URL=$WORKER_URL' >> ~/.zshrc"
echo ""
echo "3. Test the deployment:"
echo "   curl $WORKER_URL"
echo ""
echo "4. Use the CLI:"
echo "   cd packages/cli"
echo "   ./dist/cli.js --help"
echo "   ./dist/cli.js --api-url $WORKER_URL --ttl 1"
echo ""
echo "5. Optional: Install CLI globally"
echo "   cd packages/cli && bun link"
echo ""
echo -e "${YELLOW}Note: Remember to revoke any API tokens used during deployment${NC}"
echo ""

# Verify deployment
echo "Verifying deployment..."
if curl -s "$WORKER_URL" | grep -q "diff-share-worker"; then
    echo -e "${GREEN}✓ Worker is responding correctly!${NC}"
else
    echo -e "${YELLOW}⚠ Worker response verification failed. Please check manually.${NC}"
fi

echo ""
echo "Done! 🎉"
