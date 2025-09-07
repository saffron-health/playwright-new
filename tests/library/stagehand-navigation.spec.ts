/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { browserTest as test, expect } from "../config/browserTest";

// npx playwright test tests/library/stagehand-navigation.spec.ts --headed
test("should navigate to Stagehand docs and click act element", async ({
  page,
}) => {
  // Navigate to the Stagehand documentation
  await page.goto("https://docs.stagehand.dev/first-steps/introduction");

  // Wait for the page to load
  await page.waitForLoadState("networkidle");

  //  Try using this locator to test: locator("xpath=/html/body/div[2]/div[2]/div[3]/div[2]/div[2]/span[2]").click();

  await page.pause();

  await page.pause();

  // Click the element with id='/basics/act'
  await page.click("#/basics/act");

  // Verify we're on the correct page by checking the URL
  await expect(page).toHaveURL(/.*\/basics\/act/);

  // Optional: Verify the page title or content
  await expect(page.locator("h1")).toContainText("Act");
});
