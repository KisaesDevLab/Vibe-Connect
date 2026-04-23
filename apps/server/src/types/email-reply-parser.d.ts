declare module 'email-reply-parser' {
  class EmailReplyParser {
    read(text: string): { getVisibleText(): string; getFragments(): unknown[] };
  }
  export default EmailReplyParser;
}
