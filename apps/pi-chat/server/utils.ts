export async function jsonBody<T>(request: Request): Promise<T> {
    try {
        return await request.json() as T;
    } catch {
        return {} as T;
    }
}
