import Link from 'next/link';

const LINKS = [
  { href: '/', label: 'Manager' },
  { href: '/staff', label: 'Staff' },
  { href: '/tools', label: 'Tools' },
];

export default function SiteNav() {
  return (
    <header className="mb-6 border-b pb-3">
      <p className="font-semibold">RotaProof</p>
      <nav aria-label="Main">
        <ul className="flex gap-4">
          {LINKS.map((link) => (
            <li key={link.href}>
              <Link href={link.href} className="underline">
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
