#!/usr/bin/env swift
// Verify a NotchOS activation token with CryptoKit, the way the Mac app does.
//
//   swift scripts/verify-token.swift <token> <public-key-base64>
//
//   <token>              base64url(payload) + "." + base64url(signature), as the API returns it
//   <public-key-base64>  the raw 32-byte Ed25519 public key in base64, as printed by
//                        scripts/gen-signing-key.ts
//
// Prints the decoded payload, then VALID (exit 0) or INVALID with the reason (exit 1).
// Wrong usage exits 2.
//
// The signature is checked over the payload bytes exactly as they are in the token. The
// payload is never parsed and written out again before the check; it is only shown.
// This proves that tokens signed by Node's crypto verify in CryptoKit (LICENSE plan test
// row 5: a token with an edited date is rejected).

import CryptoKit
import Foundation

func finish(_ line: String, exitCode: Int32) -> Never {
    print(line)
    exit(exitCode)
}

func encodeBase64url(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

/// Strict base64url (RFC 4648 section 5, no padding). Returns nil unless `text` is the one
/// canonical spelling of some bytes, so every edited character is noticed.
func decodeBase64url(_ text: String) -> Data? {
    let alphabet = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
    guard !text.isEmpty, text.unicodeScalars.allSatisfy({ alphabet.contains($0) }) else { return nil }
    var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while base64.count % 4 != 0 { base64.append("=") }
    guard let data = Data(base64Encoded: base64), encodeBase64url(data) == text else { return nil }
    return data
}

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
    FileHandle.standardError.write(
        Data("usage: swift scripts/verify-token.swift <token> <public-key-base64>\n".utf8))
    exit(2)
}
let token = arguments[1]
var publicKeyText = arguments[2]
while publicKeyText.count % 4 != 0 { publicKeyText.append("=") }

guard let publicKeyBytes = Data(base64Encoded: publicKeyText), publicKeyBytes.count == 32,
    let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKeyBytes)
else {
    finish("INVALID: the public key must be the raw 32 bytes in base64", exitCode: 1)
}

let parts = token.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
guard parts.count == 2 else {
    finish("INVALID: a token is two base64url parts joined by one dot", exitCode: 1)
}
guard let payload = decodeBase64url(parts[0]) else {
    finish("INVALID: the payload part is not canonical base64url", exitCode: 1)
}

// Show what the token claims, whatever the check below says.
print("payload: \(String(data: payload, encoding: .utf8) ?? "<\(payload.count) bytes, not UTF-8>")")

guard let signature = decodeBase64url(parts[1]) else {
    finish("INVALID: the signature part is not canonical base64url", exitCode: 1)
}
guard signature.count == 64 else {
    finish("INVALID: the signature is \(signature.count) bytes, an Ed25519 signature has 64", exitCode: 1)
}
guard publicKey.isValidSignature(signature, for: payload) else {
    finish("INVALID: the signature does not match the payload", exitCode: 1)
}
guard (try? JSONSerialization.jsonObject(with: payload)) is [String: Any] else {
    finish("INVALID: the signature matches, but the payload is not a JSON object", exitCode: 1)
}
finish("VALID", exitCode: 0)
