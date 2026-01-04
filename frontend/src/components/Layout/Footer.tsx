import { Github, Twitter, FileText } from 'lucide-react';

const socialLinks = [
  { href: 'https://github.com/lazy-protocol', icon: Github, label: 'GitHub' },
  { href: 'https://twitter.com/lazyprotocol', icon: Twitter, label: 'Twitter' },
  { href: '/docs', icon: FileText, label: 'Docs' },
];

export function Footer() {
  return (
    <footer className="border-t border-lazy-navy-light bg-lazy-navy mt-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex flex-col md:flex-row items-center justify-between gap-4">
          {/* Logo */}
          <div className="flex items-center">
            <span className="text-xl font-bold text-drift-white">lazy</span>
            <span className="text-yield-gold text-xl ml-0.5">.</span>
          </div>

          {/* Links */}
          <div className="flex items-center gap-6">
            {socialLinks.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target={link.href.startsWith('http') ? '_blank' : undefined}
                rel={link.href.startsWith('http') ? 'noopener noreferrer' : undefined}
                className="text-drift-white/50 hover:text-yield-gold transition-colors"
                aria-label={link.label}
              >
                <link.icon className="w-5 h-5" />
              </a>
            ))}
          </div>

          {/* Copyright */}
          <p className="text-sm text-drift-white/50">
            &copy; {new Date().getFullYear()} Lazy Protocol. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
