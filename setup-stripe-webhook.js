#!/usr/bin/env node

const { execSync } = require('child_process');

console.log('Stripe Webhook Setup Guide');
console.log('==========================\n');

console.log('Follow these steps to configure your Stripe webhook:\n');

console.log('1. Go to your Stripe Dashboard: https://dashboard.stripe.com/webhooks');
console.log('2. Click "Add endpoint"');
console.log('3. Enter your webhook URL:');
console.log('   https://ai-commenting-sidekick.automatemybiz.pro/api/stripe-webhook\n');

console.log('4. Select the following events:');
console.log('   - checkout.session.completed');
console.log('   - customer.subscription.created');
console.log('   - customer.subscription.updated');
console.log('   - customer.subscription.deleted');
console.log('   - invoice.payment_succeeded');
console.log('   - invoice.payment_failed\n');

console.log('5. After creating the webhook, copy the "Signing secret" (it starts with whsec_)\n');

console.log('6. Set the webhook secret in Vercel:');
console.log('   Run: vercel env add STRIPE_WEBHOOK_SECRET\n');

console.log('Current environment variables status:');

// Check if vercel CLI is installed
try {
  execSync('vercel --version', { stdio: 'ignore' });
  console.log('\n✓ Vercel CLI is installed\n');
  
  console.log('To add the webhook secret, run:');
  console.log('vercel env add STRIPE_WEBHOOK_SECRET production');
  console.log('(paste your webhook signing secret when prompted)\n');
  
  console.log('To verify all environment variables are set:');
  console.log('vercel env ls production\n');
} catch (error) {
  console.log('\n✗ Vercel CLI not found. Install it with: npm i -g vercel\n');
}

console.log('7. After setting the webhook secret, redeploy your backend:');
console.log('   vercel --prod\n');

console.log('Testing webhook configuration:');
console.log('After deployment, visit: https://ai-commenting-sidekick.automatemybiz.pro/api/test-stripe-config');
console.log('It should show hasStripeWebhookSecret: true\n');