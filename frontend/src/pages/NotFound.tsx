import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <section className="section" style={{ minHeight: '60vh', display: 'flex', alignItems: 'center' }}>
      <div className="container" style={{ textAlign: 'center' }}>
        <h1 className="hero-title" style={{ marginBottom: 'var(--space-md)' }}>
          Nothing here.
        </h1>
        <p className="hero-subtitle" style={{ marginBottom: 'var(--space-xl)' }}>
          Just like your portfolio if you don't deposit.
        </p>
        <Link to="/" className="btn btn-gold">
          Go to Vaults
        </Link>
      </div>
    </section>
  );
}
