export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="bg-muted min-h-svh">
      {children}
    </div>
  )
}
