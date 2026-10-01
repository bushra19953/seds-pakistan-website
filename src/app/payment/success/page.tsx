export default function PaymentSuccessPage() {
    return (
        <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
            <h1 className="text-4xl font-bold mb-4 text-green-500">Payment Successful!</h1>
            <p className="text-lg text-muted-foreground mb-8">
                Thank you for your purchase. Your registration has been confirmed and we've saved your order.
            </p>
            <a
                href="/events"
                className="px-6 py-3 bg-primary text-primary-foreground rounded-lg font-semibold hover:opacity-90 transition-opacity"
            >
                Back to Events
            </a>
        </div>
    );
}
