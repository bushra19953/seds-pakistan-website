import { test, expect } from '@playwright/test';

test('blog listing loads and shows cards', async ({ page }) => {
  await page.goto('http://localhost:9004/blog');
  await expect(page.locator('text=Blog Posts')).toBeVisible({ timeout: 10000 });
  const cards = page.locator('[class*="Card"]');
  await expect(cards.first()).toBeVisible({ timeout: 10000 });
});

test('blog slug page renders content', async ({ page }) => {
  await page.goto('http://localhost:9004/blog');
  const firstLink = page.locator('a[href^="/blog/"]').first();
  await firstLink.click();
  await expect(page.locator('text=Share')).toBeVisible({ timeout: 10000 });
});
