# Getting Started

@Metadata {
    @DisplayName("Getting Started")
    @PageColor(blue)
}

Welcome to the sample library.

> Important: Always pin an explicit version.
> The pack records provenance for every file.

@Comment {
    Internal note with { nested } braces that must never ship.
}

## Install

@TabNavigator {
    @Tab("Swift Package Manager") {
        Add the dependency to `Package.swift`.

        ```swift
        .package(url: "https://example.com/sample.git", from: "1.0.0")
        ```
    }

    @Tab("CocoaPods") {
        Add `pod 'Sample'` to your Podfile.
    }
}

## Layout

@Row {
    @Column {
        The left column explains requests.
    }

    @Column {
        The right column explains responses.
    }
}

@Image(source: "hero.png", alt: "Sample architecture diagram")

@Video(source: "intro.mov", alt: "Getting started tour")

@Snippet(path: "Sample/Snippets/hello", slice: "setup")

## 快速入门

中文标题也需要稳定的标识符。
