export function appendHandoffCredential(formData: FormData, handoffToken: string): void {
  formData.set('handoffToken', handoffToken);
}
