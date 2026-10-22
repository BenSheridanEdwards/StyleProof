// Ask BenSheridanEdwards to sign off a PR that loosens or rewrites a gate file
// (ADR 0008, ported from AgenticRepoTemplate ADRs 0023 and 0024).
//
// .github/workflows/enforcement-approval.yml runs this module from the default
// branch's checkout through actions/github-script, so main's copy judges every
// PR. It reads the guarded files at the merge base and at the PR head through
// the API and never runs PR code. When a guarded file changes, it keeps one
// comment that lists the changes and carries a checkbox bound to the head
// commit, and sets the `enforcement-approval` commit status to pending. The
// status turns green only on the edit event in which APPROVER, as a GitHub
// user, turns this head's unticked box into a ticked one and changes nothing
// else. The gate then labels the box with who ticked it and when. Any other
// edit, and every new head, rewrites the comment unticked.
//
// `GUARDS`, `enforcementProblems`, `signoffComment` and `planApproval` are the
// pure core; `run` is the thin GitHub shell. Run directly,
// `node scripts/enforcement-approval.mjs --git <base> [<head>]` prints
// `{ head, problems }` for a local branch.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** The commit status context a branch-protection rule can require. */
export const STATUS_CONTEXT = 'enforcement-approval';

/** Marks the one comment this gate owns. */
export const COMMENT_MARKER = '<!-- enforcement-approval -->';

/** The author of the comments and statuses this workflow writes. */
export const GATE_AUTHOR = 'github-actions[bot]';

/** The one GitHub user whose tick signs off enforcement changes. */
export const APPROVER = 'BenSheridanEdwards';

/**
 * The files that run the gates, in order; the first guard with a matching
 * pattern owns a path. Each is code or shell, which can loosen a gate in ways a
 * text diff cannot rank, and the gate never runs PR code, so any edit asks:
 * adding, changing, deleting or renaming one. The gate's own files come first
 * so a change to the gate names itself.
 */
export const GUARDS = [
  {
    area: 'Enforcement-approval gate',
    paths: [
      /^\.github\/workflows\/enforcement-approval\.yml$/,
      /^scripts\/enforcement-approval\.mjs$/,
      /^test\/enforcement-approval\.test\.mjs$/,
    ],
    edit: 'edits the enforcement-approval gate',
  },
  { area: 'CI workflows', paths: [/^\.github\/workflows\//] },
  { area: 'Git hooks', paths: [/^\.husky\//] },
  { area: 'Lint config', paths: [/^eslint\.config\.js$/, /^commitlint\.config\.js$/] },
  { area: 'Repo checks', paths: [/^scripts\/check-suppressions\.mjs$/, /^scripts\/check-context-layer\.mjs$/] },
];

/** The most files "list pull request files" returns; past it, guarded files can hide. */
export const LIST_FILES_LIMIT = 3000;

const TOO_MANY_FILES = {
  path: 'this PR',
  area: 'Gate input',
  reason: `changes ${LIST_FILES_LIMIT} or more files, past what the API lists, so the gate cannot see every guarded file`,
};

const guardFor = (path) => GUARDS.find((guard) => guard.paths.some((pattern) => pattern.test(path)));

/**
 * Put a PR-sourced string in one code span where it cannot add a line, a
 * checkbox, a table cell, a mention or invisible text.
 */
const inert = (text) =>
  `\`${String(text)
    .replaceAll('`', "'")
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')}\``;

/**
 * Every guarded path on either side of a "list pull request files" response,
 * sorted. A rename is two paths: the old one reads as deleted, the new one as
 * added.
 */
export function guardedPaths(files) {
  const paths = files.flatMap((file) => [file.filename, file.previous_filename ?? '']);
  return [...new Set(paths.filter((path) => path && guardFor(path)))].sort();
}

/**
 * One problem per guarded file the PR lists, a mode-only change included.
 * `before` and `after` are the file's text at the merge base and the head, or
 * null where it is absent.
 */
export function enforcementProblems(changes) {
  return changes
    .flatMap(({ path, before, after }) => {
      const guard = guardFor(path);
      if (!guard) return [];
      const reason =
        before === null
          ? 'adds enforcement code'
          : after === null
            ? 'deletes the file'
            : (guard.edit ?? 'edits enforcement code');
      return [{ path, area: guard.area, reason }];
    })
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** Keeps the comment well inside GitHub's comment size limit. */
const MAX_ROWS = 100;

const APPROVAL_TEXT = 'Approve these enforcement changes at ';

/** Formats a time in London, where Ben works, in the parts the label needs. */
const LONDON = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  hour: 'numeric',
  minute: '2-digit',
  hourCycle: 'h12',
});

const ordinal = (day) =>
  day % 100 >= 11 && day % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] ?? 'th');

/** `Monday, the 12th of October, at 3 pm` for `at` in Europe/London. */
export function londonTime(at) {
  const part = Object.fromEntries(LONDON.formatToParts(at).map(({ type, value }) => [type, value]));
  const day = Number(part.day);
  const minute = part.minute === '00' ? '' : `:${part.minute}`;
  return `${part.weekday}, the ${day}${ordinal(day)} of ${part.month}, at ${Number(part.hour)}${minute} ${String(part.dayPeriod).toLowerCase()}`;
}

/**
 * A profile name as plain text: one line, every character outside letters,
 * digits, spaces, `.`, `'` and `-` written as an HTML entity, so it cannot close
 * the label, add markdown, or mention anyone.
 */
const plainText = (text) =>
  [
    ...text
      .replace(/[\p{Cc}\p{Cf}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim(),
  ]
    .slice(0, 100)
    .join('')
    .replace(/[^\p{L}\p{N} .'-]/gu, (char) => `&#${char.codePointAt(0)};`);

/**
 * The small italic note after a ticked box. It records the tick for people; the
 * gate never reads it back as evidence.
 */
export function approvalLabel({ name, login, at }) {
  const handle = login.replace(/[^A-Za-z0-9-]/g, '');
  const shown = plainText(name ?? '') || handle;
  return `<sub><i>Approved by ${shown} @${handle} on ${londonTime(at)}</i></sub>`;
}

const refusalNote = (login) => `A tick by ${inert(login)} was cleared. Only ${APPROVER} signs off enforcement changes.`;

/** Matches the refusal note and the blank line after it. */
const REFUSAL_NOTE = /\nA tick by `[^`\n]*` was cleared\. Only \S+ signs off enforcement changes\.\n/;

/**
 * The sign-off comment for `problems` at commit `head`: unticked, unticked with
 * a note naming whose tick the gate just cleared, or ticked with the label when
 * the gate has just seen the approver tick it.
 */
export function signoffComment({ head, problems, approval, refusedBy }) {
  const box = approval
    ? `- [x] ${APPROVAL_TEXT}${inert(head)} ${approvalLabel(approval)}`
    : `- [ ] ${APPROVAL_TEXT}${inert(head)}`;
  return [
    COMMENT_MARKER,
    '## Enforcement sign-off',
    '',
    'This PR loosens or rewrites what the gates enforce:',
    '',
    '| File | Area | Change |',
    '| --- | --- | --- |',
    ...problems.slice(0, MAX_ROWS).map((problem) => `| ${inert(problem.path)} | ${problem.area} | ${problem.reason} |`),
    ...(problems.length > MAX_ROWS ? [`| | | and ${problems.length - MAX_ROWS} more changes |`] : []),
    '',
    ...(refusedBy === undefined ? [] : [refusalNote(refusedBy), '']),
    `@${APPROVER} signs off by ticking the box below in GitHub. The tick counts for commit ${inert(head)} only. A new push clears it, and a tick from any other account is cleared.`,
    box,
    '',
  ].join('\n');
}

const CLEAR_BODY = `${COMMENT_MARKER}\nNothing in this PR loosens enforcement now, so it needs no sign-off.\n`;

const normalise = (body) => body.replaceAll('\r\n', '\n').trimEnd();

const hasTick = (body) => /^\s*[-*+]\s+\[[xX]\]/m.test(body);

const isApprover = (sender) => sender.type === 'User' && sender.login === APPROVER;

/**
 * Whether `event` is the approver turning this head's unticked box, with or
 * without a refusal note, into a ticked one and changing nothing else.
 */
function isFreshTick({ event, unticked }) {
  const { sender, from, to } = event;
  if (!isApprover(sender) || from === null) return false;
  const before = normalise(from);
  const ticked = ['x', 'X'].map((box) => before.replace('\n- [ ] ', `\n- [${box}] `));
  return before.replace(REFUSAL_NOTE, '') === unticked && ticked.includes(normalise(to));
}

/**
 * Whether `body` is the gate's labelled comment for this head and these
 * problems. The gate leaves such a body in place only while its own latest
 * status for the head is the sign-off, so the text never makes an approval.
 */
function isLabelled(body, unticked) {
  const box = /\n- \[x\] (.*) <sub><i>Approved by [^<\n]*<\/i><\/sub>\n/;
  const text = normalise(body);
  return box.test(`${text}\n`) && normalise(`${text}\n`.replace(box, '\n- [ ] $1\n')) === unticked;
}

const signedOffStatus = (head) => ({ state: 'success', description: `${APPROVER} signed off at ${head.slice(0, 7)}` });

/** Pending, not failure: nothing is wrong with the PR, it waits on a person (ADR 0008). */
const WAITING = {
  state: 'pending',
  description: `Waiting for ${APPROVER} to tick the enforcement sign-off box for this commit`,
};

/**
 * Plan for an edit of the comment: approve the approver's fresh tick while the
 * comment is unchanged since it, clear any other edit, and name whoever else
 * left a tick. Returns undefined for a fresh tick the comment has moved past.
 */
function planEdit({ head, problems, comment, event }) {
  const unticked = signoffComment({ head, problems });
  if (!isFreshTick({ event, unticked: normalise(unticked) })) {
    const refused = hasTick(event.to) && !isApprover(event.sender);
    return {
      commentBody: refused ? signoffComment({ head, problems, refusedBy: event.sender.login }) : unticked,
      status: WAITING,
    };
  }
  const unchanged =
    comment !== undefined && normalise(comment.body) === normalise(event.to) && comment.updatedAt === event.at;
  if (!unchanged) return undefined;
  const { login, name } = event.sender;
  return {
    commentBody: signoffComment({ head, problems, approval: { name: name ?? null, login, at: new Date(event.at) } }),
    status: signedOffStatus(head),
  };
}

/**
 * Decide the comment body and the commit status. Pure. `status: null` leaves
 * the head's status as it is; `commentBody: null` writes no comment.
 *
 * Only an edit event that is the approver's fresh tick on this head's comment,
 * with the comment unchanged since that edit, signs off. Any other edit clears
 * the box. A PR event, or a tick the comment has since moved past, keeps the
 * gate's label for this head without posting a status while `signedOff` says
 * the gate's own latest status for the head is the sign-off, and resets
 * anything else.
 */
export function planApproval({ head, problems, comment, signedOff, event }) {
  if (problems.length === 0) {
    return {
      commentBody: comment ? CLEAR_BODY : null,
      status: { state: 'success', description: 'Nothing in this PR loosens enforcement' },
    };
  }
  const edit = event.kind === 'comment' && planEdit({ head, problems, comment, event });
  if (edit) return edit;
  const unticked = signoffComment({ head, problems });
  if (signedOff && comment && isLabelled(comment.body, normalise(unticked))) {
    return { commentBody: comment.body, status: null };
  }
  return { commentBody: unticked, status: WAITING };
}

/** Read one file at `ref` through the API, or null when it is absent there. */
async function readFile(github, repo, path, ref) {
  try {
    const { data } = await github.rest.repos.getContent({ ...repo, path, ref, mediaType: { format: 'raw' } });
    return String(data);
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

/**
 * The gate's own comment, or undefined. Like the StyleProof approve workflow,
 * trust comes from the API's author, never the text: only a comment the
 * GitHub Actions bot wrote counts. On an edit, the edited comment comes first,
 * and it counts when its marker was there before the edit. A gate comment that
 * lost its marker but keeps the approval line also counts, so the gate restores
 * it even when the edit's own run never ran.
 */
function findSignoffComment(comments, event) {
  const hadMarker = (id) =>
    event.kind === 'comment' && event.commentId === id && Boolean(event.from?.startsWith(COMMENT_MARKER));
  const signoff = comments.filter(
    (comment) =>
      comment.user?.type === 'Bot' &&
      comment.user?.login === GATE_AUTHOR &&
      (comment.body?.startsWith(COMMENT_MARKER) || comment.body?.includes(APPROVAL_TEXT) || hadMarker(comment.id)),
  );
  const existing = signoff.find((comment) => event.kind === 'comment' && comment.id === event.commentId) ?? signoff[0];
  return existing && { id: existing.id, body: String(existing.body), updatedAt: existing.updated_at };
}

/**
 * What triggered this run. An edit carries its sender and the body before and
 * after it; GitHub sets them, the comment text cannot.
 */
async function gateEvent(github, context) {
  if (context.eventName !== 'issue_comment') return { kind: 'pull' };
  const { comment, changes, sender } = context.payload;
  const name =
    sender.login === APPROVER ? (await github.rest.users.getByUsername({ username: sender.login })).data.name : null;
  return {
    kind: 'comment',
    commentId: comment.id,
    sender: { login: sender.login, type: sender.type, name },
    from: changes?.body?.from ?? null,
    to: String(comment.body),
    at: comment.updated_at,
  };
}

/**
 * Whether the gate's own latest status on `head` is the sign-off. Anyone with
 * write access can post a status, so only the gate's count.
 */
async function isSignedOff(github, repo, head) {
  const { data: statuses } = await github.rest.repos.listCommitStatusesForRef({ ...repo, ref: head, per_page: 100 });
  const latest = statuses.find((status) => status.context === STATUS_CONTEXT && status.creator?.login === GATE_AUTHOR);
  const signed = signedOffStatus(head);
  return latest?.state === signed.state && latest?.description === signed.description;
}

/** Create or update the gate's comment when its body changes. */
async function writeComment({ github, repo, number, existing, body }) {
  if (body === null || body === existing?.body) return;
  await (existing
    ? github.rest.issues.updateComment({ ...repo, comment_id: existing.id, body })
    : github.rest.issues.createComment({ ...repo, issue_number: number, body }));
}

/**
 * The actions/github-script entry point. It reads the head, the files and the
 * comment live, so a rerun or a late run judges the PR as it is now, and posts
 * the status on that head. A rerun with nothing new writes no comment.
 */
export async function run({ github, context, core }) {
  const repo = context.repo;
  const number = context.payload.pull_request?.number ?? context.payload.issue?.number;
  const { data: pullRequest } = await github.rest.pulls.get({ ...repo, pull_number: number });
  const head = pullRequest.head.sha;
  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...repo,
    basehead: `${pullRequest.base.sha}...${head}`,
  });
  const mergeBase = comparison.merge_base_commit.sha;

  const files = await github.paginate(github.rest.pulls.listFiles, { ...repo, pull_number: number, per_page: 100 });
  const changes = await Promise.all(
    guardedPaths(files).map(async (path) => ({
      path,
      before: await readFile(github, repo, path, mergeBase),
      after: await readFile(github, repo, path, head),
    })),
  );
  const problems = [...(files.length >= LIST_FILES_LIMIT ? [TOO_MANY_FILES] : []), ...enforcementProblems(changes)];

  const comments = await github.paginate(github.rest.issues.listComments, {
    ...repo,
    issue_number: number,
    per_page: 100,
  });
  const event = await gateEvent(github, context);
  const existing = findSignoffComment(comments, event);

  const plan = planApproval({
    head,
    problems,
    comment: existing,
    signedOff: await isSignedOff(github, repo, head),
    event,
  });
  await writeComment({ github, repo, number, existing, body: plan.commentBody });

  if (!plan.status) {
    core.info(`${STATUS_CONTEXT}: left as it is for ${head}`);
    return;
  }
  await github.rest.repos.createCommitStatus({
    ...repo,
    sha: head,
    context: STATUS_CONTEXT,
    state: plan.status.state,
    description: plan.status.description,
  });
  core.info(`${STATUS_CONTEXT}: ${plan.status.state} — ${plan.status.description}`);
}

function runCli(argv) {
  const index = argv.indexOf('--git');
  if (index === -1 || !argv[index + 1]) {
    console.error('Usage: node scripts/enforcement-approval.mjs --git <base> [<head>]');
    process.exitCode = 2;
    return;
  }
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const head = git('rev-parse', argv[index + 2] ?? 'HEAD').trim();
  const base = git('merge-base', argv[index + 1], head).trim();
  const show = (ref, path) => {
    try {
      return git('show', `${ref}:${path}`);
    } catch {
      return null;
    }
  };
  const names = git('diff', '--name-only', '--no-renames', '-z', `${base}...${head}`).split('\0');
  const paths = guardedPaths(names.filter(Boolean).map((filename) => ({ filename })));
  const problems = enforcementProblems(
    paths.map((path) => ({ path, before: show(base, path), after: show(head, path) })),
  );
  console.log(JSON.stringify({ head, problems }, null, 2));
}

// Run the CLI only when invoked directly, not when imported by a test or the workflow.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2));
}
