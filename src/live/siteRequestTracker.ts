export class SiteRequestTracker {
  private currentRequest = 0;

  begin(): number {
    this.currentRequest += 1;
    return this.currentRequest;
  }

  invalidate(): void {
    this.currentRequest += 1;
  }

  isCurrent(request: number): boolean {
    return request === this.currentRequest;
  }
}
