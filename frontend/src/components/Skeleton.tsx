interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  className?: string;
}

export function Skeleton({ width = '100%', height = 14, className = '' }: SkeletonProps) {
  return (
    <div
      className={`skeleton ${className}`}
      style={{
        width: typeof width === 'number' ? `${width}px` : width,
        height: typeof height === 'number' ? `${height}px` : height,
      }}
    />
  );
}

export function SkeletonRow({ count = 3 }: { count?: number }) {
  return (
    <div style={{ padding: 'var(--space-md)' }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="skeleton-row">
          <Skeleton width={80} height={14} />
          <Skeleton width={60} height={14} />
        </div>
      ))}
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="backing-data-card">
      <div className="backing-data-header">
        <Skeleton width={120} height={20} />
        <Skeleton width={70} height={24} />
      </div>
      <SkeletonRow count={4} />
    </div>
  );
}
