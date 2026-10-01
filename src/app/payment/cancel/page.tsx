export default function PaymentCancelPage() {
    return (
        <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
            <h1 className="text-4xl font-bold mb-4 text-red-500">Payment Cancelled</h1>
            <p className="text-lg text-muted-foreground mb-8">
                Your payment was not completed. You have not been charged.
            </p>
            <a
                href="/events"
                className="px-6 py-3 bg-primary text-primary-foreground rounded-lg font-semibold hover:opacity-90 transition-opacity"
            >
                Explore Events
            </a>
        </div>
    );
}
