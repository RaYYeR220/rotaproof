'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Manager' },
  { href: '/staff', label: 'Staff' },
  { href: '/tools', label: 'Tools' },
];

/**
 * The mark, and the three views.
 *
 * The nav is the smallest instance of the idea the whole page is built on: the pills sit
 * in a shallow well, and the one you are looking at is the one pressed into it.
 */
export default function SiteNav() {
  const pathname = usePathname();

  return (
    <header className="site-head">
      <div className="mark">
        <span className="glyph" aria-hidden="true" />
        <p className="wordmark">RotaProof</p>
      </div>

      <nav aria-label="Main">
        <ul className="navpills">
          {LINKS.map((link) => {
            const current = pathname === link.href;
            return (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="navpill"
                  {...(current ? { 'aria-current': 'page' as const } : {})}
                >
                  {link.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </header>
  );
}
