//! The pinned deterministic-math profile.
//!
//! @ref LLP 1003 §5 (determinism)
//!
//! Every transcendental the evaluator calls routes through this module, so the
//! same transition advanced to the same time produces the same bits on every
//! target this crate compiles for. Rust does not contract separate
//! multiply/add expressions into FMA, so the authored rounding survives too.

/// The `libm` release whose software kernels define the profile.
pub const LIBM_PINNED_VERSION: &str = "0.2.16";

/// Deterministic software exponential.
#[inline]
pub fn exp(x: f64) -> f64 {
    libm::exp(x)
}

/// Deterministic `exp(x) - 1`, retaining small differences.
#[inline]
pub fn expm1(x: f64) -> f64 {
    libm::expm1(x)
}

/// Deterministic software sine.
#[inline]
pub fn sin(x: f64) -> f64 {
    libm::sin(x)
}

/// Deterministic software cosine.
#[inline]
pub fn cos(x: f64) -> f64 {
    libm::cos(x)
}

/// Deterministic software power with `Math.pow`'s answers where C's `pow` differs: a NaN exponent, or a base of
/// magnitude 1 to an infinite exponent, is NaN.
#[inline]
pub fn pow(x: f64, y: f64) -> f64 {
    if y.is_nan() || (x.abs() == 1.0 && y.is_infinite()) {
        return f64::NAN;
    }
    libm::pow(x, y)
}

/// Deterministic software natural logarithm: UIKit spring conversions solve
/// with it.
#[inline]
pub fn ln(x: f64) -> f64 {
    libm::log(x)
}

/// IEEE 754 binary64 square root — correctly rounded by the standard, so the
/// platform intrinsic is already architecture-independent for finite inputs.
#[inline]
pub fn sqrt(x: f64) -> f64 {
    x.sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pow_answers_as_math_pow_does() {
        assert_eq!(pow(2.0, 10.0), 1024.0);
        assert!(pow(1.0, f64::NAN).is_nan());
        assert!(pow(-1.0, f64::INFINITY).is_nan());
        assert!(pow(1.0, f64::NEG_INFINITY).is_nan());
        assert_eq!(pow(0.5, f64::INFINITY), 0.0);
        assert_eq!(pow(0.0, 0.0), 1.0);
        assert!(pow(-8.0, 1.0 / 3.0).is_nan());
        assert!((pow(0.6, 1.3) - 0.514750320266457).abs() < 1e-15);
    }

    #[test]
    fn cargo_lock_matches_the_pinned_libm() {
        let lock = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../Cargo.lock"))
            .expect("read workspace Cargo.lock");
        let mut versions = Vec::new();
        let mut name = None;
        for line in lock.lines() {
            if line == "[[package]]" {
                name = None;
            } else if let Some(v) = line.strip_prefix("name = \"") {
                name = Some(v.trim_end_matches('"'));
            } else if let (Some("libm"), Some(v)) = (name, line.strip_prefix("version = \"")) {
                versions.push(v.trim_end_matches('"').to_string());
            }
        }
        assert_eq!(
            versions,
            [LIBM_PINNED_VERSION],
            "Cargo.lock's libm moved; move LIBM_PINNED_VERSION with it and re-check the easing and spring fixtures"
        );
    }

    #[test]
    fn kernels_route_to_libm() {
        assert_eq!(exp(1.0).to_bits(), libm::exp(1.0).to_bits());
        assert_eq!(expm1(1e-10).to_bits(), libm::expm1(1e-10).to_bits());
        assert_eq!(sin(1.0).to_bits(), libm::sin(1.0).to_bits());
        assert_eq!(cos(1.0).to_bits(), libm::cos(1.0).to_bits());
        assert_eq!(ln(2.0).to_bits(), libm::log(2.0).to_bits());
    }
}
