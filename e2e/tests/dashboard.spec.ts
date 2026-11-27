// The owner dashboard end to end, against the production build and the demo seed (apps/server/src/seed-demo.ts).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = process.env.OWNER_PASSWORD ?? 'demo';
const ROUTES: [string, string | RegExp][] = [
  ['dashboard', 'Needs you'], ['people', 'People'], ['people/1', 'Rafi Ahmed'], ['devices', 'Devices'],
  ['teams', 'Teams & Admins'], ['teams/1', /^Backend$/], ['accounts', 'Claude accounts'],
  ['repositories', 'Repositories'], ['activity', 'When the team works'], ['git', 'Git output'],
  ['models', 'Models & cost'], ['content', 'Captured content'], ['alerts', /^Alerts$/], ['audit', 'Audit log'], ['settings', 'Settings'],
];

async function signIn(page: Page) {
  expect((await page.request.post('/api/auth/login', { data: { password: PASSWORD } })).ok()).toBe(true);
}
/** Fails the test on any console error or uncaught exception. */
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}
async function open(page: Page, route: string, heading: string | RegExp) {
  await page.goto(`/#/${route}`);
  await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
}

test('sign-in: a wrong password is refused, the right one opens the dashboard', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Owner password').fill('wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('That password is wrong')).toBeVisible();
  await page.getByLabel('Owner password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Needs you' })).toBeVisible();
});

for (const scheme of ['light', 'dark'] as const) {
  for (const [width, label] of [[1440, 'desktop'], [390, 'phone']] as const) {
    test(`every page renders cleanly: ${label}, ${scheme}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, timezoneId: 'Asia/Dhaka' });
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      await signIn(page);
      for (const [route, heading] of ROUTES) {
        await open(page, route, heading);
        await page.waitForLoadState('networkidle');
        // Nothing wider than the screen: tables scroll inside their own box instead.
        expect(await page.evaluate(() => document.documentElement.scrollWidth), `${route} overflows`).toBeLessThanOrEqual(width);
        if (label === 'desktop') {
          const axe = await new AxeBuilder({ page }).analyze();
          const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
            .map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
          expect(serious, `${route} accessibility`).toEqual([]);
        }
        await page.screenshot({ path: `out/screens/${label}-${scheme}-${route.replace('/', '-')}.png`, fullPage: true });
      }
      expect(errors).toEqual([]);
      await ctx.close();
    });
  }
}

test('accounts: one card per account, the account filter survives a reload, a lead sees only their accounts and claims an unassigned person', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/dashboard');
  const strip = page.getByRole('region', { name: 'Allowance by Claude account' });
  for (const name of ['Backend seat', 'Unlabeled account 2', 'Shared research seat']) await expect(strip.getByRole('heading', { name })).toBeVisible();
  await page.getByLabel('Filter allowance by Claude account').selectOption({ label: 'Shared research seat' });
  await expect(strip.getByRole('heading', { name: 'Backend seat' })).toHaveCount(0);
  await page.reload();
  await expect(strip.getByRole('heading', { name: 'Shared research seat' })).toBeVisible();
  await expect(strip.getByRole('heading', { name: 'Backend seat' })).toHaveCount(0);

  // Backend's lead: Backend's own account and the shared one its devices use; never Frontend-only account.
  expect((await page.request.post('/api/auth/login', { data: { email: 'shamim@northwind.dev', password: 'demo-lead' } })).ok()).toBe(true);
  await page.goto('/#/dashboard?account=');
  await expect(strip.getByRole('heading', { name: 'Backend seat' })).toBeVisible();
  await expect(strip.getByRole('heading', { name: 'Unlabeled account 2' })).toHaveCount(0);
  await expect(strip.getByText(/Other teams/).first()).toBeVisible();
  await open(page, 'people', 'People');
  await page.getByRole('button', { name: /^Add to Backend\s*, Farhan Ali$/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Farhan Ali moved to Backend' })).toBeVisible();
});

test('the Add members and Add account dialogs pass the accessibility check', async ({ page }) => {
  await signIn(page);
  const check = async (what: string) => {
    const axe = await new AxeBuilder({ page }).include('dialog[open]').analyze();
    expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id), what).toEqual([]);
  };
  await open(page, 'teams/1', /^Backend$/);
  await page.getByRole('button', { name: 'Add members' }).click();
  await expect(page.getByRole('dialog', { name: 'Add people to Backend' }).getByRole('checkbox').first()).toBeVisible();
  await check('add members dialog');
  await page.keyboard.press('Escape');
  await open(page, 'accounts', 'Claude accounts');
  await page.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByRole('dialog', { name: 'Add a Claude account' })).toBeVisible();
  await check('add account dialog');
});

test('range picker and global search', async ({ page }) => {
  await signIn(page);
  await open(page, 'dashboard', 'Needs you');
  const range = page.getByRole('radiogroup', { name: 'Date range' });
  const refetch = page.waitForResponse((r) => r.url().includes('/api/dashboard/analytics?range=30d'));
  await range.getByRole('radio', { name: 'Last 30 days' }).click();
  await refetch;
  await expect(range.getByRole('radio', { name: 'Last 30 days' })).toHaveAttribute('aria-checked', 'true');

  await page.getByLabel('Search people, devices, repositories').fill('tanvir');
  await page.getByRole('button', { name: /Tanvir Hossain\s*Person/ }).dispatchEvent('mousedown');
  await expect(page.getByRole('heading', { level: 1, name: 'Tanvir Hossain' })).toBeVisible();
  await expect(page).toHaveURL(/#\/people\/\d+$/);
});

test('invite: create a link, open it as the teammate would, cancel it', async ({ page, context }) => {
  await signIn(page);
  await open(page, 'people', 'People');
  const name = `Test ${Date.now()}`;
  await page.getByRole('button', { name: 'Invite a teammate' }).click();
  await page.getByLabel('Teammate’s name').fill(name);
  await page.getByRole('button', { name: 'Create link' }).click();
  await expect(page.getByRole('heading', { name: `Send this to ${name}` })).toBeVisible();
  const link = await page.getByLabel('Invite link').textContent();
  expect(link).toMatch(/\/join#ccm_inv_[A-Za-z0-9_-]{20,}$/);
  await expect(page.getByLabel('Install command')).toContainText(`--config 'invite=${link}'`);

  // The join page is static: it must never call the API or show dashboard data.
  const teammate = await context.browser()!.newPage();
  const calls: string[] = [];
  teammate.on('request', (r) => { if (r.url().includes('/api/')) calls.push(r.url()); });
  await teammate.goto(link!);
  await expect(teammate.getByRole('heading', { name: /Connect Claude Code/ })).toBeVisible();
  await expect(teammate.getByLabel('Install command')).toContainText(link!);
  expect(calls).toEqual([]);
  await teammate.goto(link!.replace(/#.*/, '#broken'));
  await expect(teammate.getByText('This link is incomplete')).toBeVisible();
  await teammate.close();

  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: `Actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Cancel open link' }).click();
  await open(page, 'audit', 'Audit log');
  await expect(page.getByRole('cell', { name: `Invite link for ${name} cancelled` })).toBeVisible();
});

test('devices: rename, remove and restore', async ({ page }) => {
  await signIn(page);
  await open(page, 'devices', 'Devices');
  const fresh = `imran-laptop-${Date.now() % 10000}`;
  const row = page.getByRole('row').filter({ hasText: 'Imran Malik' }).first();
  await row.getByRole('button', { name: /^Actions for / }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByLabel('Device name').fill(fresh);
  await page.getByRole('button', { name: 'Save' }).click();
  const renamed = page.getByRole('row').filter({ hasText: fresh });
  await expect(renamed).toBeVisible();

  await renamed.getByRole('button', { name: `Actions for ${fresh}` }).click();
  await page.getByRole('menuitem', { name: 'Remove device' }).click();
  await renamed.getByRole('button', { name: 'Remove device' }).click();
  await expect(renamed.getByText('Removed')).toBeVisible();
  await renamed.getByRole('button', { name: `Actions for ${fresh}` }).click();
  await page.getByRole('menuitem', { name: 'Restore device' }).click();
  await expect(renamed.getByText('Removed')).toHaveCount(0);
});

test('flags: marking one reviewed takes it off the list', async ({ page }) => {
  await signIn(page);
  await open(page, 'dashboard', 'Needs you');
  const list = page.locator('section[aria-labelledby="needs"] ol > li');
  const first = list.first();
  const title = (await first.locator('p').first().textContent())!;
  await first.getByRole('button', { name: 'Mark reviewed' }).click();
  await page.getByLabel('Review note').fill('talked to them');
  await page.getByRole('button', { name: 'Mark reviewed' }).first().click();
  await expect(list.filter({ hasText: title })).toHaveCount(0);
  await open(page, 'audit', 'Audit log');
  await expect(page.getByText('talked to them').first()).toBeVisible();
});

test('audit log: filter by action and export CSV', async ({ page }) => {
  await signIn(page);
  await open(page, 'audit', 'Audit log');
  const filtered = page.waitForResponse((r) => r.url().includes('/api/dashboard/audit?') && r.url().includes('action=device.joined'));
  await page.getByRole('combobox').filter({ hasText: 'All actions' }).selectOption('device.joined');
  await filtered;
  const rows = page.locator('tbody tr');
  await expect(rows.first()).toContainText('device.joined');
  for (const text of await rows.allTextContents()) expect(text).toContain('device.joined');

  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export CSV' }).click();
  const csv = await (await download).path().then((p) => import('node:fs').then((fs) => fs.readFileSync(p!, 'utf8')));
  expect(csv.split('\n')[0]).toBe('time,actor,action,person,device,details');
  expect(csv.split('\n').slice(1).every((l) => l.includes('device.joined'))).toBe(true);
});

test('settings: saving thresholds creates a new policy revision', async ({ page }) => {
  await signIn(page);
  await open(page, 'settings', 'Settings');
  const before = Number((await page.getByText(/Policy revision \d+/).textContent())!.match(/\d+/)![0]);
  await page.getByLabel(/Flag 00:00 to 06:00 share/).fill('30');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText(new RegExp(`revision ${before + 1}`))).toBeVisible();
  await page.getByLabel(/Flag 00:00 to 06:00 share/).fill('25');
  await page.getByRole('button', { name: 'Save settings' }).click();
});

test('content capture: a switch saves a revision; captured content filters by kind and text', async ({ page }) => {
  await signIn(page);
  await open(page, 'settings', 'Settings');
  const errors = page.getByRole('checkbox', { name: /API error messages/ });
  await expect(errors).toBeChecked();
  await errors.uncheck();
  await page.getByRole('button', { name: 'Save capture settings' }).click();
  await expect(page.getByText(/Saved as policy revision \d+\. Each device applies it/)).toBeVisible();
  await errors.check();
  await page.getByRole('button', { name: 'Save capture settings' }).click();

  await open(page, 'content', 'Captured content');
  await expect(page.getByText(/Capturing prompt text, commands and tool input/)).toBeVisible();
  const items = page.locator('main ol > li');
  const kinded = page.waitForResponse((r) => r.url().includes('/api/dashboard/content?') && r.url().includes('kind=diff'));
  await page.getByLabel('Kind').selectOption('diff');
  await kinded;
  await expect(items.first()).toContainText('Edit diff');
  for (const t of await items.allTextContents()) expect(t).toContain('Edit diff');
  await page.getByRole('button', { name: 'Clear' }).click();
  await page.getByLabel('Search text and file paths').fill('cover letter');
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText('Tanvir Hossain');
});

test('sign out returns to the sign-in page and locks the API', async ({ page }) => {
  await signIn(page);
  await open(page, 'dashboard', 'Needs you');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Owner password')).toBeVisible();
  expect((await page.request.get('/api/dashboard/overview')).status()).toBe(401);
});

test('milestone 4: 5h window switch, high-effort sessions, alert banner, teams page, and team lead RBAC', async ({ page }) => {
  await signIn(page);
  await open(page, 'dashboard', 'Needs you');

  // Persistent alert banner is visible on load and can be acknowledged.
  const banner = page.getByRole('region', { name: 'Active admin alerts' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Blocked Tanvir Hossain');

  // Switch between weekly and Current 5h window via the range picker.
  const range = page.getByRole('radiogroup', { name: 'Date range' });
  const fiveH = page.waitForResponse((r) => r.url().includes('/api/dashboard/sessions?range=five_hour'));
  await range.getByRole('radio', { name: 'Current 5h' }).click();
  await fiveH;
  await expect(page.getByRole('heading', { name: '5-hour allowance over time' })).toBeVisible();

  // Sessions ledger shows xhigh filter tab.
  const xhighRes = page.waitForResponse((r) => r.url().includes('effort=xhigh'));
  await page.getByRole('radiogroup', { name: 'Session view' }).getByRole('radio', { name: /xhigh effort/ }).click();
  await xhighRes;

  // Acknowledge the active alert banner.
  await banner.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(banner).toHaveCount(0);

  // Superadmin manages Teams & Admins.
  await open(page, 'teams', 'Teams & Admins');
  await expect(page.getByRole('cell', { name: 'Backend', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'shamim@northwind.dev' })).toBeVisible();

  // Sign out and sign in as Team Lead (shamim@northwind.dev / demo-lead): sees ONLY Backend team, no Settings link.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByLabel('Email').fill('shamim@northwind.dev');
  await page.getByLabel('Owner password').fill('demo-lead');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Needs you' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Teams & Admins' })).toHaveCount(0);
  await open(page, 'people', 'People');
  await expect(page.getByRole('button', { name: /Rafi Ahmed/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Nila Chowdhury/ })).toHaveCount(0);
});

test('milestone 5: clickable activity calendar drill-down, git email mapping modal, and guard/webhook settings', async ({ page }) => {
  await signIn(page);

  // Activity page: click an active day cell on the GitHub-style calendar and verify Selected Period Inspector loads.
  await open(page, 'activity', 'When the team works');
  const activeCell = page.locator('button[aria-label*="sessions"]:not([aria-label*="0 sessions"])').first();
  await expect(activeCell).toBeVisible();
  const drill = page.waitForResponse((r) => decodeURIComponent(r.url()).includes('/api/dashboard/sessions?range=day:'));
  await activeCell.click();
  await drill;
  await expect(page.getByRole('region', { name: 'Selected period details' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear selection' }).click();

  // Git page: unmapped authors stay out of Recent team commits and live inside the Email Mapping modal.
  await open(page, 'git', 'Git output');
  await expect(page.getByText('contractor@agency.io')).toHaveCount(0);
  await page.getByRole('button', { name: /Map teammate emails/ }).click();
  await expect(page.getByRole('heading', { name: 'Map teammate commit emails' })).toBeVisible();
  await expect(page.getByText('contractor@agency.io')).toBeVisible();
  await page.getByRole('button', { name: 'Close modal' }).click();

  // Settings page: Repository Guard mode saves cleanly and labels warn as silent admin-only.
  await open(page, 'settings', 'Settings');
  await expect(page.getByLabel('Outside-work repository mode')).toContainText('Alert admin only (silent)');
  await page.getByLabel('Outside-work repository mode').selectOption('block');
  await page.getByRole('button', { name: 'Save guard rules' }).click();
  await expect(page.getByText(/Saved as policy revision \d+\. Devices refresh guard rules/)).toBeVisible();
  await page.getByLabel('Outside-work repository mode').selectOption('warn');
  await page.getByRole('button', { name: 'Save guard rules' }).click();

  // People & Devices show Needs update badge and GitLab-to-GitHub migration snippet for deprecated plugins.
  await open(page, 'people', 'People');
  await expect(page.getByRole('row').filter({ hasText: 'Imran Malik' })).toContainText('Needs update');
  await open(page, 'devices', 'Devices');
  await expect(page.getByLabel('Switch marketplace to GitHub and update plugin')).toContainText('remote set-url origin https://github.com/neeomdumham/claude-usage-monitor.git');

  // Reconnect device (refresh token in place) opens a single-use reconnect link modal.
  const devRow = page.getByRole('row').filter({ hasText: 'Imran Malik' }).first();
  await devRow.getByRole('button', { name: /^Actions for / }).click();
  await page.getByRole('menuitem', { name: 'Reconnect device (refresh token)' }).click();
  await expect(page.getByRole('heading', { name: /Reconnect .* \(Imran Malik\)/ })).toBeVisible();
  await expect(page.getByText(/Refreshes this device’s token in place/)).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
});
