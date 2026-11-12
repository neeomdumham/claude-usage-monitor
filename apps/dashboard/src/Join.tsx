import { useEffect, useState } from 'react';
import { installCommand, MARKETPLACE_URL, TRANSPARENCY_URL } from './lib.ts';
import { Copy } from './People.tsx';

/** What a teammate sees if they open their invite link in a browser. The secret stays in the fragment. */
export function Join() {
  const [link, setLink] = useState(window.location.href);
  useEffect(() => { // a corrected link pasted into the same tab only changes the fragment
    const on = () => setLink(window.location.href);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const token = new URL(link).hash.slice(1);
  const valid = /^ccm_inv_[A-Za-z0-9_-]{20,80}$/.test(token);

  return (
    <main className="mx-auto w-full max-w-[680px] px-4 py-16 sm:px-8">
      <h1 className="text-3xl font-semibold">Connect Claude Code to your team's usage monitor</h1>
      {!valid ? (
        <p className="mt-4 text-limit">
          This link is incomplete. Copy the whole link your admin sent, including everything after the #.
        </p>
      ) : (
        <>
          <p className="mt-3 text-muted">
            Your admin invited you. Run this once in a terminal, then restart Claude Code. You keep using your own setup token.
          </p>
          <Copy text={installCommand(link)} label="Install command" />

          <p className="mt-8 font-medium">Prefer doing it inside Claude Code?</p>
          <Copy text={`/plugin marketplace add ${MARKETPLACE_URL}`} />
          <Copy text="/plugin install usage-monitor@usage-monitor-tools" />
          <p className="mt-2 text-sm text-muted">Paste this page's address when it asks for the invite link, then restart.</p>
        </>
      )}

      <div className="mt-12 border-t border-rule pt-6 text-sm">
        <h2 className="font-medium">What your admin will see</h2>
        <p className="mt-1 text-muted">
          Allowance percentages, which models you used and how many tokens, tool names, permission modes, the repository
          name, commit and line counts, and when. Prompts are checked on your computer for things like pasted secrets;
          only a label is sent, and you're told when that happens. Never your prompts, code, file contents, command text
          or your token.{' '}
          <a className="underline underline-offset-2 hover:text-ink" href={TRANSPARENCY_URL}>Full list</a>
        </p>
        <p className="mt-2 text-muted">The link works on two devices for 72 hours. Don't share it with anyone else.</p>
      </div>
    </main>
  );
}
