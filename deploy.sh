#!/bin/bash

# Diff Share Deployment Script
# Usage: ./deploy.sh [options]
#   ./deploy.sh           Quick update (Worker + CLI only)
#   ./deploy.sh --full    Full deployment (D1 + R2 + Worker + CLI)
#   ./deploy.sh --init    First time setup (create D1, R2, schema)
#   ./deploy.sh --help    Show this help

set -e  # Exit on error

# Parse arguments
MODE="quick"
WORKER_ONLY=false
MIGRATE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --full)
      MODE="full"
      shift
      ;;
    --init)
      MODE="init"
      shift
      ;;
    --worker-only)
      WORKER_ONLY=true
      shift
      ;;
    --migrate)
      MIGRATE=true
      shift
      ;;
    --help|-h)
      echo "Diff Share Deployment Script"
      echo ""
      echo "Usage: ./deploy.sh [options]"
      echo ""
      echo "Options:"
      echo "  (no args)      Quick update - deploy Worker and CLI only (default)"
      echo "  --full         Full deployment - create D1, R2, init schema, deploy"
      echo "  --init         Initialize only - create D1, R2, init schema (no deploy)"
      echo "  --migrate      Migrate database schema (for schema updates)"
      echo "  --worker-only  Deploy only the Worker (skip CLI build)"
      echo "  --help, -h     Show this help message"
      echo ""
      echo "Examples:"
      echo "  ./deploy.sh              # Quick update after code changes"
      echo "  ./deploy.sh --full       # First time deployment"
      echo "  ./deploy.sh --migrate    # Update database schema only"
      echo "  ./deploy.sh --worker-only # Only update Worker code"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Run './deploy.sh --help' for usage information"
      exit 1
      ;;
  esac
done

echo "=================================="
echo "Diff Share - Deployment Script"
if [ "$MIGRATE" = true ]; then
    echo "Mode: migrate"
elif [ "$WORKER_ONLY" = true ]; then
    echo "Mode: worker-only"
else
    echo "Mode: $MODE"
fi
echo "=================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
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
        echo -e "${YELLOW}⚠ Please update the placeholder values in wrangler.toml${NC}"
        read -p "Press Enter after updating wrangler.toml..."
    else
        echo -e "${RED}Error: Neither wrangler.toml nor wrangler.toml.example found${NC}"
        exit 1
    fi
fi

# Check dependencies (only in full/init mode or if tools missing)
if [ "$MODE" = "full" ] || [ "$MODE" = "init" ] || ! command -v wrangler &> /dev/null || ! command -v bun &> /dev/null; then
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
fi

# Install dependencies (only if node_modules missing or in full mode)
if [ "$MODE" = "full" ] || [ "$MODE" = "init" ] || [ ! -d "node_modules" ]; then
    echo "Installing project dependencies..."
    bun install
    echo -e "${GREEN}✓ Dependencies installed${NC}"
    echo ""
fi

# Check authentication (skip in quick mode if already logged in)
if [ "$MODE" != "quick" ]; then
    echo "Checking Cloudflare authentication..."
    WRANGLER_WHOAMI=$(wrangler whoami 2>&1 || true)

    if echo "$WRANGLER_WHOAMI" | grep -q "Not logged in"; then
        echo "Not logged in. Please login to Cloudflare..."
        wrangler login
    else
        echo -e "${GREEN}✓ Already logged in${NC}"
    fi
    echo ""
fi

cd packages/worker

# ============================================================================
# INITIALIZATION (D1 + R2) - Only in --full or --init mode
# ============================================================================

if [ "$MODE" = "full" ] || [ "$MODE" = "init" ]; then
    echo -e "${BLUE}=== Infrastructure Setup ===${NC}"
    echo ""

    # Create D1 database
    echo "Creating D1 database..."
    if ! wrangler d1 list 2>/dev/null | grep -q "diff-share-db"; then
        echo "Creating new D1 database 'diff-share-db'..."
        wrangler d1 create diff-share-db 2>&1 | tee /tmp/d1_output.txt

        # Extract database ID
        DATABASE_ID=$(grep -oE 'database_id: "[^"]+' /tmp/d1_output.txt | sed 's/database_id: "//' || \
                       grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' /tmp/d1_output.txt | head -1 || \
                       echo "")

        if [ -n "$DATABASE_ID" ]; then
            echo "Database ID: $DATABASE_ID"
            if [[ "$OSTYPE" == "darwin"* ]]; then
                sed -i '' "s/database_id = \"\"/database_id = \"$DATABASE_ID\"/" wrangler.toml
            else
                sed -i "s/database_id = \"\"/database_id = \"$DATABASE_ID\"/" wrangler.toml
            fi
            echo -e "${GREEN}✓ Updated wrangler.toml${NC}"
        else
            echo -e "${YELLOW}⚠ Please manually update database_id in wrangler.toml${NC}"
            read -p "Press Enter after updating..."
        fi
    else
        echo -e "${YELLOW}Database 'diff-share-db' already exists${NC}"
    fi
    echo ""

    # Create R2 bucket
    echo "Creating R2 bucket..."
    if ! wrangler r2 bucket list 2>/dev/null | grep -q "diff-share-files"; then
        wrangler r2 bucket create diff-share-files
        echo -e "${GREEN}✓ R2 bucket created${NC}"
    else
        echo -e "${YELLOW}Bucket 'diff-share-files' already exists${NC}"
    fi
    echo ""

    # Get R2 public URL - first check if already configured
    echo "Configuring R2 public URL..."
    
    # Check if R2_PUBLIC_URL is already set in wrangler.toml (not the placeholder)
    CURRENT_R2_URL=$(grep "R2_PUBLIC_URL" wrangler.toml | grep -v "^#" | cut -d'"' -f2 || echo "")
    
    if [ -n "$CURRENT_R2_URL" ] && [ "$CURRENT_R2_URL" != "https://pub-xxxxxxxx.r2.dev" ]; then
        echo -e "${GREEN}✓ R2 URL already configured: $CURRENT_R2_URL${NC}"
        R2_URL="$CURRENT_R2_URL"
    else
        # Try to auto-detect from wrangler
        R2_INFO=$(wrangler r2 bucket info diff-share-files 2>&1 || echo "")
        R2_URL=$(echo "$R2_INFO" | grep -oE 'https://pub-[a-zA-Z0-9]+\.r2\.dev' | head -1 || echo "")
        
        if [ -z "$R2_URL" ]; then
            echo -e "${YELLOW}⚠ Could not auto-detect R2 URL${NC}"
            read -p "Enter your R2 public URL (e.g., https://pub-xxx.r2.dev): " R2_URL
        fi
        
    if [ -n "$R2_URL" ]; then
        # Replace any existing R2_PUBLIC_URL value with the new one
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s|R2_PUBLIC_URL = \"[^\"]*\"|R2_PUBLIC_URL = \"$R2_URL\"|" wrangler.toml
        else
            sed -i "s|R2_PUBLIC_URL = \"[^\"]*\"|R2_PUBLIC_URL = \"$R2_URL\"|" wrangler.toml
        fi
        echo -e "${GREEN}✓ R2 URL configured: $R2_URL${NC}"
    fi
    fi
    echo ""

    # Initialize database schema
    echo "Initializing database schema..."
    echo "This will execute SQL on the REMOTE database..."

    if ! wrangler d1 execute diff-share-db --file=./schema.sql --remote 2>&1; then
        echo ""
        echo -e "${YELLOW}⚠ Schema initialization may have failed.${NC}"
        echo "If this is the first deploy, wait 30 seconds and retry."
        read -p "Retry schema initialization? (y/n): " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            wrangler d1 execute diff-share-db --file=./schema.sql --remote
        fi
    else
        echo -e "${GREEN}✓ Database schema initialized${NC}"
    fi
    echo ""

    if [ "$MODE" = "init" ]; then
        echo -e "${GREEN}=== Initialization Complete ===${NC}"
        echo ""
        echo "Next steps:"
        echo "  1. Review wrangler.toml configuration"
        echo "  2. Run './deploy.sh' to deploy Worker"
        exit 0
    fi
fi

# ============================================================================
# SCHEMA MIGRATION - Only in --migrate mode
# ============================================================================

if [ "$MIGRATE" = true ]; then
    echo -e "${BLUE}=== Database Migration ===${NC}"
    echo ""
    
    # Check if we should use migration file or schema file
    if [ -f "schema-migration.sql" ]; then
        echo "Found schema-migration.sql"
        read -p "Use migration file (preserves data) or full schema (recreates)? (migration/schema): " MIGRATION_TYPE
        
        if [ "$MIGRATION_TYPE" = "schema" ]; then
            SQL_FILE="./schema.sql"
            echo -e "${YELLOW}⚠ Using schema.sql will reset all data!${NC}"
            read -p "Are you sure? (y/N): " -n 1 -r
            echo ""
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                echo "Migration cancelled."
                exit 0
            fi
        else
            SQL_FILE="./schema-migration.sql"
        fi
    else
        SQL_FILE="./schema.sql"
    fi
    
    echo "Executing: $SQL_FILE"
    if ! wrangler d1 execute diff-share-db --file="$SQL_FILE" --remote 2>&1; then
        echo ""
        echo -e "${YELLOW}⚠ Migration may have failed.${NC}"
        echo "If D1 is still initializing, wait 30 seconds and retry."
        read -p "Retry? (y/n): " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            wrangler d1 execute diff-share-db --file="$SQL_FILE" --remote
        fi
    else
        echo -e "${GREEN}✓ Database schema migrated${NC}"
    fi
    echo ""
    
    echo -e "${GREEN}=== Migration Complete ===${NC}"
    echo ""
    echo "Next: Run './deploy.sh' to deploy the updated Worker"
    exit 0
fi

# ============================================================================
# DEPLOYMENT (Worker + CLI)
# ============================================================================

echo -e "${BLUE}=== Deployment ===${NC}"
echo ""

# Deploy Worker
echo "Deploying Worker..."
DEPLOY_OUTPUT=$(wrangler deploy 2>&1)
echo "$DEPLOY_OUTPUT"

# Extract Worker URL
    WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.workers\.dev' | head -1 || echo "")

if [ -n "$WORKER_URL" ]; then
    echo ""
    echo -e "${GREEN}✓ Worker deployed: $WORKER_URL${NC}"
else
        WORKER_URL="$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[a-zA-Z0-9_-]+\.workers\.dev' | head -1 || echo "")"
    if [ -z "$WORKER_URL" ]; then
        WORKER_URL="https://diff-share-worker.<account>.workers.dev"
    fi
fi

if [ "$WORKER_ONLY" = true ]; then
    echo ""
    echo -e "${GREEN}=== Worker Updated ===${NC}"
    echo ""
    echo "Worker URL: $WORKER_URL"
    exit 0
fi

# Build CLI
echo ""
echo "Building CLI..."
cd ../cli
bun run build
echo -e "${GREEN}✓ CLI built${NC}"

# Summary
echo ""
echo "=================================="
echo -e "${GREEN}Deployment Complete!${NC}"
echo "=================================="
echo ""
echo "Worker URL: $WORKER_URL"
echo ""
echo "Next steps:"
echo "  1. Set API URL:"
echo "     export DIFF_SHARE_API_URL=$WORKER_URL"
echo ""
echo "  2. Add to ~/.zshrc for persistence:"
echo "     echo 'export DIFF_SHARE_API_URL=$WORKER_URL' >> ~/.zshrc"
echo ""
echo "  3. Test the CLI:"
echo "     ./packages/cli/dist/cli.js --help"
echo "     git diff | ./packages/cli/dist/cli.js"
echo ""

# Verify deployment
echo "Verifying Worker..."
if curl -s "$WORKER_URL" 2>/dev/null | grep -q "diff-share-worker"; then
    echo -e "${GREEN}✓ Worker is responding!${NC}"
else
    echo -e "${YELLOW}⚠ Could not verify Worker. It may take a moment to start.${NC}"
fi

echo ""
echo "Done! 🎉"
